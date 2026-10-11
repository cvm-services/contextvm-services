/**
 * three_buddies_venue_test.ts — the venue record for Three Buddies Steglitz.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A cold review of a sibling PR found its e2e VACUOUS: it derived its
 * expectation from the artefact under test, so a fabricated venue passed 41/0.
 * Every price assertion in this file therefore compares the record against
 * something the record was NOT built from:
 *
 *   - the text a real browser rendered on the venue's own ordering page
 *     (evidence/rendered-ordering-page.txt), and
 *   - the raw API payload committed under evidence/raw/menus.json.
 *
 * The page check is verified to be able to FAIL: `perturbed price is caught`
 * mutates a copy of the record and requires the very same comparison to report a
 * mismatch. A check that cannot fail proves nothing, so that mutation is part of
 * the suite rather than a claim in the README.
 *
 * Run: deno task test
 */

const VENUE_DIR = new URL("../venues/three-buddies-berlin/", import.meta.url);
const SLUG = "three-buddies-berlin";
/** The venue's own published business phone — the ONE phone the record carries. */
const PUBLISHED_PHONE = "+49 30 48625381";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function readJson(rel: string): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(new URL(rel, VENUE_DIR)));
}
async function readText(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, VENUE_DIR));
}

const venue = await readJson("venue.json");
const anchor = await readJson("evidence/anchor/page-price-anchor.json");
const pageText = await readText("evidence/rendered-ordering-page.txt");
const rawMenus = await readJson("evidence/raw/menus.json");

// --------------------------------------------------------------------------- //
// the checks (shared with the negative test, on purpose)
// --------------------------------------------------------------------------- //

/** name -> price, read from the RENDERED PAGE. The storefront separates the
 *  number from the sign with a non-breaking space (U+00A0). */
function parsePagePrices(text: string): Map<string, number> {
  const lines = text.split("\n").map((l) => l.trim());
  const out = new Map<string, number>();
  const priceRe = /^(\d{1,3},\d{2})[ \u00a0]*€$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(priceRe);
    if (!m) continue;
    let name = "";
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j]) {
        name = lines[j];
        break;
      }
    }
    if (!name || name.startsWith("🏅") || name.startsWith("#")) continue;
    if (!out.has(name)) out.set(name, Number(m[1].replace(",", ".")));
  }
  return out;
}

/** Compare the record against page-read prices. Returns the mismatches. */
function compareRecordToPage(record: Json, page: Map<string, number>): string[] {
  const byName = new Map<string, Json>();
  for (const item of record.menu.items) if (!byName.has(item.name)) byName.set(item.name, item);
  const bad: string[] = [];
  for (const [name, pagePrice] of page) {
    const item = byName.get(name);
    if (!item) {
      bad.push(`${name}: rendered at ${pagePrice} EUR but absent from venue.json`);
      continue;
    }
    const rec = item.prices_by_order_method?.pickup ?? item.price;
    if (rec === null || rec === undefined || Math.abs(rec - pagePrice) > 1e-9) {
      bad.push(`${name}: venue.json=${rec} page=${pagePrice}`);
    }
  }
  return bad;
}

/** Compare the record's prices against the RAW payload it claims to come from. */
function compareRecordToRawMenus(record: Json, menus: Json): string[] {
  const products = menus.data.products as Record<string, Json>;
  const bad: string[] = [];
  for (const item of record.menu.items) {
    const p = products[item.sku];
    if (!p) {
      bad.push(`${item.sku}: not in the raw menus payload`);
      continue;
    }
    if (Math.abs(Number(p.base_price) - item.price) > 1e-9) {
      bad.push(`${item.sku} ${item.name}: raw=${p.base_price} record=${item.price}`);
    }
    for (const [method, price] of Object.entries(item.prices_by_order_method ?? {})) {
      const raw = p.order_method_prices?.[method];
      if (raw === undefined) {
        bad.push(`${item.sku}: record invents a '${method}' price`);
        continue;
      }
      if (Math.abs(Number(raw) - Number(price)) > 1e-9) {
        bad.push(`${item.sku} ${method}: raw=${raw} record=${price}`);
      }
    }
  }
  return bad;
}

function deepCopy<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

// --------------------------------------------------------------------------- //
// tests
// --------------------------------------------------------------------------- //

Deno.test("record shape: slug, schema, and the generated-by pointer", () => {
  assertEquals(venue.schema, "cvm.venue/v1", "schema");
  assertEquals(venue.slug, SLUG, "slug");
  assertEquals(
    venue.generated_by,
    `venues/${SLUG}/adapter.py`,
    "the record names the adapter that generates it",
  );
});

Deno.test("every price in the record comes from the raw payload (not from the record)", () => {
  const bad = compareRecordToRawMenus(venue, rawMenus);
  assertEquals(bad, [], "record vs evidence/raw/menus.json");
  assert(venue.menu.items.length >= 50, `expected a full menu, got ${venue.menu.items.length}`);
  assert(
    Object.keys(rawMenus.data.products).length >= venue.menu.items.length,
    "the raw payload must contain at least the listed items",
  );
});

Deno.test("NON-VACUOUS: the record matches the venue's OWN rendered page", () => {
  const page = parsePagePrices(pageText);
  assert(
    page.size >= 50,
    `the page anchor must cover a real menu, parsed only ${page.size} rows`,
  );
  const bad = compareRecordToPage(venue, page);
  assertEquals(bad, [], "record vs the rendered ordering page");
  // ...and the anchor file is not stale: it must describe the same page.
  const anchorNames = anchor.entries.map((e: Json) => e.name).sort();
  assertEquals(anchorNames, [...page.keys()].sort(), "the committed anchor == the page dump");
  for (const e of anchor.entries) {
    assertEquals(e.price_eur, page.get(e.name), `anchor price for ${e.name}`);
  }
});

Deno.test("the page check CAN fail: a perturbed price is caught", () => {
  const page = parsePagePrices(pageText);
  const target = anchor.entries[0].name;
  const wanted = anchor.entries[0].price_eur + 1;
  const perturbed = deepCopy(venue);
  const hit = perturbed.menu.items.find((i: Json) => i.name === target);
  assert(hit, `anchor item '${target}' must exist in the record`);
  hit.price = wanted;
  hit.prices_by_order_method.pickup = wanted;

  // The unperturbed record passes ...
  assertEquals(compareRecordToPage(venue, page), [], "sanity: the real record passes");
  // ... and the perturbed one must NOT.
  const bad = compareRecordToPage(perturbed, page);
  assert(
    bad.length === 1 && bad[0].includes(target),
    `the check must catch the perturbed price; got ${JSON.stringify(bad)}`,
  );
  assert(
    bad[0].includes(String(wanted)),
    `the failure must name the perturbed value; got ${bad[0]}`,
  );
  // A wholesale fabrication must also fail: an invented record with one price
  // moved per item cannot pass.
  const fabricated = deepCopy(venue);
  for (const item of fabricated.menu.items) {
    if (item.price !== null && item.price !== undefined) {
      item.price += 0.5;
      if (item.prices_by_order_method?.pickup !== undefined) {
        item.prices_by_order_method.pickup += 0.5;
      }
    }
  }
  assert(
    compareRecordToPage(fabricated, page).length >= 50,
    "a fabricated menu must fail loudly, not pass 41/0",
  );
});

Deno.test("the venue sets a company-id trap and the record documents it", () => {
  // The storefront payload binds store 481 to company 509; the venue's own
  // ordering page loads company 550, and BOTH answer /menus with 200 and
  // different menus. The record must publish the disagreement, not hide it.
  assertEquals(venue.venue.store_id, 481, "store id");
  assertEquals(venue.venue.company_binding.storefront_payload_company_id, 509, "storefront company");
  assertEquals(venue.venue.company_binding.resolved_company_id, 550, "resolved company");
  assertEquals(venue.venue.company_binding.agrees, false, "the disagreement is admitted");
  assertEquals(venue.venue.company_id, 550, "the record follows the venue's own page");
  assert(
    String(venue.venue.company_binding.note).includes("550"),
    "the note must say which company the record follows",
  );
  // the anchor is a page of the venue's own site — same venue, same city.
  assert(
    /threebuddies\.de/.test(venue.venue.ordering.primary_url),
    "the ordering URL is the venue's own host",
  );
});

Deno.test("locality: Steglitz, Berlin, and the published address", () => {
  assertEquals(venue.venue.address.quarter, "Steglitz", "Ortsteil");
  assertEquals(venue.venue.address.city, "Berlin", "city");
  assertEquals(venue.venue.address.postal_code, "12167", "postal code");
  assertEquals(venue.venue.address.street, "Albrechtstraße 131", "street");
  assert(
    Math.abs(venue.venue.address.lat - 52.457) < 0.01 &&
      Math.abs(venue.venue.address.lon - 13.322) < 0.01,
    `coordinates must be in Steglitz, got ${venue.venue.address.lat},${venue.venue.address.lon}`,
  );
});

Deno.test("both service methods are offered, and pickup is the page-verified one", () => {
  assertEquals(venue.venue.order_methods, ["pickup", "delivery"], "service methods");
  assertEquals(venue.venue.pickup.available, true, "pickup available");
  assertEquals(venue.venue.delivery.available, true, "delivery available");
  // every listed item carries a pickup price (the column the page renders)
  const missing = venue.menu.items.filter((i: Json) => i.prices_by_order_method?.pickup === undefined);
  assertEquals(missing.map((i: Json) => i.sku), [], "items without a pickup price");
});

Deno.test("ADR-0007: the adapter class is stated and no capability is overclaimed", () => {
  const a = venue.venue.adapter;
  assertEquals(a.class, "deep_link_human", "adapter class");
  // key order is not the point; the capability SET is
  assertEquals(
    Object.entries(a.capabilities).sort(),
    [["menu", true], ["quote", true], ["status", false], ["submit", false]],
    "capabilities",
  );
  assert(
    a.capabilities.submit === false && a.capabilities.status === false,
    "the CVM must not claim it can place or track an order",
  );
  assertEquals(a.browser_automation_used, false, "the adapter re-fetches JSON; it does not drive a browser");
  assert(a.why_this_class.length > 50, "the class decision must be explained, not asserted");
  assert(Array.isArray(a.human_steps) && a.human_steps.length >= 3, "human steps listed");
  // ADR-0008: the rail is the venue's own and no CVM call is priced.
  assert(/venue's own rail/.test(venue.venue.settlement.rail), "settlement rail");
  assertEquals(venue.venue.settlement.cvm_cap, null, "no priced CVM call");
});

Deno.test("stats agree with the items, and prices are sane", () => {
  const st = venue.menu.stats;
  const listed = venue.menu.items;
  assertEquals(st.items_listed, listed.length, "items_listed");
  assertEquals(st.sections, venue.menu.sections.length, "sections");
  const priced = listed.filter((i: Json) => i.price !== null && i.price !== undefined);
  assertEquals(st.items_priced_listed, priced.length, "items_priced_listed");
  assertEquals(st.min_price_listed, Math.min(...priced.map((i: Json) => i.price)), "min");
  assertEquals(st.max_price_listed, Math.max(...priced.map((i: Json) => i.price)), "max");
  assertEquals(venue.menu.currency, "EUR", "currency");
  const skus = listed.map((i: Json) => i.sku);
  assert(new Set(skus).size === skus.length, "duplicate sku");
  for (const i of listed) {
    assert(i.price === null || i.price > 0, `${i.sku}: non-positive price`);
    assert(i.name && String(i.name).length > 0, `${i.sku}: unnamed item`);
  }
  // the record claims 12 sections / 100 listed items for this venue
  assertEquals(st.sections, 12, "section count");
  assertEquals(st.items_listed, 100, "listed item count");
});

Deno.test("no PII beyond the venue's own published phone reaches the repo", async () => {
  const files = [
    "venue.json",
    "evidence/raw/store.json",
    "evidence/raw/company.json",
    "evidence/raw/menus.json",
    "evidence/rendered-ordering-page.txt",
    "evidence/anchor/page-price-anchor.json",
  ];
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // A phone-like run that STANDS ALONE. The bound excludes "." and "," too:
  // without that, the digit runs inside latitude/longitude decimals
  // (53.72541076756863) look phone-shaped and every venue fails.
  // Separators are spaces only, never \n: a newline-joining class welds a
  // street number to a postcode ("131\n\n12167") into a false phone.
  const phoneRe = /(?<![0-9A-Za-z.,-])\+?\d[0-9 \t\u00a0\-/()]{7,}\d(?![0-9A-Za-z.,-])/g;
  for (const f of files) {
    const t = await readText(f);
    const emails = (t.match(emailRe) ?? []).filter((e) => !e.includes("REDACTED"));
    assertEquals(emails, [], `${f}: an email is committed`);
    const phones = (t.match(phoneRe) ?? [])
      .map((s) => s.trim())
      .filter((s) => s !== PUBLISHED_PHONE && !s.includes("REDACTED"))
      .filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s)); // dates, not phones
    assertEquals(phones, [], `${f}: a phone number other than the venue's own`);
  }
  // the record carries the venue's phone, and no redaction placeholder.
  assertEquals(venue.venue.phone, PUBLISHED_PHONE, "the venue's published phone");
  assert(
    !JSON.stringify(venue).includes("[REDACTED"),
    "a redaction placeholder leaked into the record",
  );
  // review authors are stripped from the store copy
  assertEquals(
    venue.venue.ratings.google.reviews > 0,
    true,
    "the rating count is still published (it is venue data, not reviewer data)",
  );
});

Deno.test("the record is generated, never hand-edited", async () => {
  // The adapter writes one canonical form: indent=2, keys sorted at EVERY depth,
  // trailing newline. Asserting the shape is what catches a hand edit, because a
  // human adding a field almost never re-sorts the file.
  // (Byte-for-byte reproducibility against a rebuild is asserted by
  // `adapter.py --check`, which is the only thing that can compare bytes with the
  // generator's own number formatting.)
  const text = await readText("venue.json");
  assert(text.endsWith("}\n"), "trailing newline");
  const top = Object.keys(JSON.parse(text));
  assertEquals(top, [...top].sort(), "top-level keys are sorted");
  assertEquals(top[0], "generated_by", "the record names its generator first");
  assertEquals(top[top.length - 1], "venue", "the venue block is last");

  const unsorted: string[] = [];
  (function walk(x: Json, path: string) {
    if (Array.isArray(x)) {
      x.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (x && typeof x === "object") {
      const keys = Object.keys(x);
      const sorted = [...keys].sort();
      if (keys.join("\u0000") !== sorted.join("\u0000")) {
        unsorted.push(`${path}: ${keys.join(",")}`);
      }
      for (const k of keys) walk(x[k], `${path}.${k}`);
    }
  })(JSON.parse(text), "$");
  assertEquals(unsorted, [], "keys must be sorted at every depth");

  // Every price must be reachable from a field the evidence files contain; the
  // record claims no price the raw payload does not carry (asserted above), and
  // it must not carry a redaction placeholder either.
  assert(!text.includes("[REDACTED"), "no placeholder in the generated record");
});
