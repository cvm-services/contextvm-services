/**
 * price_semantics_test.ts — a starting price must never be served as exact.
 *
 * Finding B (PR #38 review): la-mama-berlin's page prints the qualifier BETWEEN
 * the item name and the price —
 *
 *     venues/la-mama-berlin/evidence/raw/page.txt
 *     73: 30. PIZZA MARGHERITA
 *     74: From
 *     75: 6 EUR
 *
 * — and the capture declared `skip_lines: ["From"]`, which DELETED the venue's
 * own qualifier. `venue.json` then carried `"price": 6.0, "prices_by_order_method":
 * {"pickup": 6.0}` for 44 of its 104 items with nothing to say the figure is a
 * floor, and the published kind-11316 announcement projected that catalogue into
 * a customer's sats price. la-mama is `service_method: pickup` — the one Steglitz
 * venue the operator intends to run a real money test with — so the facilitator
 * would be quoted a floor and pay the difference out of their own margin.
 *
 * These tests do NOT trust the generator: each one re-derives the qualified
 * (name, price) pairs from the committed raw evidence and requires the record and
 * the served/announced projections to mark every one of them. If a qualifier is
 * dropped, one of these fails.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIndex, handleToolCall, loadVenues } from "./server.ts";
import { venueToAnnouncement } from "../../tools/venue_to_announcement.ts";

const VENUES = new URL("../../venues/", import.meta.url);
const PRICE_LINE = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:€|EUR)$/;

/** The (name, price, qualifier) triples a venue's own page actually prints. */
async function qualifiedPricesFromEvidence(
  slug: string,
  qualifierLines: string[],
): Promise<Array<{ rawName: string; price: number; qualifier: string }>> {
  const text = await Deno.readTextFile(new URL(`${slug}/evidence/raw/page.txt`, VENUES));
  const lines = text.split("\n");
  const out: Array<{ rawName: string; price: number; qualifier: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!qualifierLines.includes(lines[i].trim())) continue;
    const next = (lines[i + 1] ?? "").trim();
    const m = PRICE_LINE.exec(next);
    if (!m) continue; // a qualifier with no price after it binds to nothing
    let prev = i - 1;
    while (prev >= 0 && !lines[prev].trim()) prev--;
    out.push({
      rawName: (lines[prev] ?? "").trim(),
      price: Number(m[1].replace(",", ".")),
      qualifier: lines[i].trim(),
    });
  }
  return out;
}

Deno.test("RED: every price the venue qualifies with 'From' is marked a starting price in the record", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("la-mama-berlin/venue.json", VENUES)),
  ) as {
    capture: { from_price_lines?: string[]; skip_lines?: string[] };
    menu: {
      items: Array<{ name: string; sku: string; price: number; price_is_from?: boolean; price_qualifier?: string | null }>;
      stats: Record<string, unknown>;
      price_semantics: { from_priced_items: number };
    };
  };

  const declared = raw.capture.from_price_lines ?? [];
  assert(
    declared.length > 0,
    "the qualifier the venue prints must be DECLARED as a qualifier: putting it in skip_lines " +
      "deletes the venue's own word and publishes a floor as an exact price",
  );
  assertEquals(
    raw.capture.skip_lines ?? [],
    [],
    "a qualifier is data, not page furniture — it must not be declared in skip_lines",
  );

  const qualified = await qualifiedPricesFromEvidence("la-mama-berlin", declared);
  assert(qualified.length > 0, "no qualifier line found in the evidence — the check would be vacuous");

  // Normalising a NAME for lookup is not the assertion: what is asserted is the
  // price and the starting-price marking. The record's `sku_from` is
  // "leading-number", so the page's "201 PIZZA CEVAPCICI" is stored without the
  // number, and a name the page glues footnote digits onto keeps them.
  const norm = (s: string) =>
    s.replace(/^\d{1,3}[.)]?\s+/, "").replace(/\s+/g, " ").replace(/[ .\u2013\u2014-]+$/, "").trim();
  const byName = new Map(raw.menu.items.map((i) => [norm(i.name), i]));
  const bySku = new Map(raw.menu.items.map((i) => [i.sku, i]));
  const missing: string[] = [];
  for (const q of qualified) {
    const sku = /^(\d{1,3})[.)]?\s+/.exec(q.rawName)?.[1];
    const item = (sku !== undefined ? bySku.get(sku) : undefined) ?? byName.get(norm(q.rawName));
    if (!item) {
      missing.push(`${q.rawName}: not in the record at all`);
      continue;
    }
    const name = item.name;
    if (item.price !== q.price) missing.push(`${name}: price ${item.price} != page's ${q.price}`);
    if (item.price_is_from !== true) missing.push(`${name}: presented as EXACT (price_is_from is not true)`);
    if (item.price_qualifier !== q.qualifier) {
      missing.push(`${name}: qualifier ${JSON.stringify(item.price_qualifier)} != the venue's ${JSON.stringify(q.qualifier)}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${qualified.length} "From"-qualified prices are presented as exact in ` +
        `venues/la-mama-berlin/venue.json:\n  ${missing.slice(0, 8).join("\n  ")}`,
    );
  }

  assertEquals(
    raw.menu.price_semantics.from_priced_items,
    qualified.length,
    "the record's own count of starting prices must equal what the evidence shows",
  );
  assertEquals(
    raw.menu.stats.from_priced_items,
    qualified.length,
    "menu.stats must carry the same count (the announcement and the server read it)",
  );
  assertEquals(
    raw.menu.items.filter((i) => i.price_is_from).length,
    qualified.length,
    "every qualified item must be flagged, and only those",
  );
});

Deno.test("RED: the same rule holds vacuously for the venues with no qualifier", async () => {
  for (const slug of ["chandi-berlin", "doreedos-steakhaus-berlin"]) {
    const raw = JSON.parse(
      await Deno.readTextFile(new URL(`${slug}/venue.json`, VENUES)),
    ) as {
      capture: { from_price_lines?: string[] };
      menu: { items: Array<{ price_is_from?: boolean }>; stats: Record<string, unknown>; price_semantics: { from_priced_items: number } };
    };
    const declared = raw.capture.from_price_lines ?? [];
    const fromEvidence = await qualifiedPricesFromEvidence(slug, declared);
    assertEquals(fromEvidence.length, 0, `${slug}: the page carries no qualifier line, so none may be claimed`);
    assertEquals(raw.menu.price_semantics.from_priced_items, 0);
    assertEquals(raw.menu.items.filter((i) => i.price_is_from).length, 0);
    assertEquals(raw.menu.stats.from_priced_items, 0);
  }
});

Deno.test("RED: the SERVED menu marks every starting price, and counts them", async () => {
  const index = await buildIndex();
  const res = handleToolCall(index, "menu", { venue_slug: "la-mama-berlin" });
  const payload = JSON.parse(res.content[0].text) as {
    total_items: number;
    from_priced_items: number;
    price_semantics_note: string;
    venues: Array<{
      venue_slug: string;
      from_priced_count: number;
      items: Array<{ name: string; prices_by_order_method: Record<string, number>; price_is_from: boolean; price_qualifier: string | null }>;
    }>;
  };
  const venue = payload.venues[0];
  assertEquals(venue.venue_slug, "la-mama-berlin");
  assertEquals(venue.from_priced_count, 44, "la-mama's served menu must report its 44 starting prices");
  assertEquals(payload.from_priced_items, 44);
  assert(
    /FLOOR/.test(payload.price_semantics_note) && /44/.test(payload.price_semantics_note),
    `the reply must say in words that these are floors: ${payload.price_semantics_note}`,
  );
  for (const item of venue.items) {
    if (item.price_is_from) {
      assert(
        typeof item.price_qualifier === "string" && item.price_qualifier.length > 0,
        `${item.name}: a flagged starting price must carry the venue's own qualifier word`,
      );
    }
  }
  assertEquals(
    venue.items.filter((i) => i.price_is_from).length,
    venue.from_priced_count,
    "the count must be the count of flagged items, not a separate claim",
  );
});

Deno.test("RED: ordering a starting-priced item returns a total flagged as a lower bound", async () => {
  const index = await buildIndex();
  // PIZZA MARGHERITA is sku 30, a "From 6 EUR" item on la-mama's pickup card.
  const res = handleToolCall(index, "order", {
    venue_slug: "la-mama-berlin",
    items: [{ sku: "30", qty: 2 }],
    fulfilment: "pickup",
    when: "asap",
    notes: "price-semantics test",
  });
  const payload = JSON.parse(res.content[0].text) as {
    total: number;
    total_is_lower_bound: boolean;
    total_lower_bound_note: string | null;
    lines: Array<{ sku: string; unit_price: number; price_is_from: boolean; price_qualifier: string | null; price_note: string | null }>;
  };
  const line = payload.lines[0];
  assertEquals(line.sku, "30");
  assertEquals(line.price_is_from, true);
  assertEquals(line.price_qualifier, "From");
  assert(
    /starting price/.test(line.price_note ?? ""),
    `the line must say the figure is a starting price: ${line.price_note}`,
  );
  assertEquals(
    payload.total_is_lower_bound,
    true,
    "a total built from a starting price is a FLOOR: presenting it as the amount to pay is the bug",
  );
  assert(/FLOOR/.test(payload.total_lower_bound_note ?? ""), `lower-bound note: ${payload.total_lower_bound_note}`);
});

Deno.test("RED: the published announcement says how many of its prices are floors", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("la-mama-berlin/venue.json", VENUES)),
  );
  const announced = venueToAnnouncement(raw).content as {
    menu: {
      item_count: number;
      min_price: number;
      price_semantics: { from_priced_count: number; exact_priced_count: number; from_qualifiers: string[]; note: string };
    };
  };
  const ps = announced.menu.price_semantics;
  assert(ps, "the announcement must carry price_semantics: the customer's sats price comes from it");
  assertEquals(ps.from_priced_count, 44);
  assertEquals(ps.exact_priced_count, 104 - 44);
  assertEquals(ps.from_qualifiers, ["From"]);
  assert(
    /FLOOR/.test(ps.note) && /lower bound/.test(ps.note),
    `the announcement must say the floor is a floor: ${ps.note}`,
  );
});

Deno.test("the venue the operator runs the money test with is the pickup venue — so this matters", async () => {
  const venues = await loadVenues(["la-mama-berlin"]);
  assertEquals(venues.length, 1);
  assertEquals(
    venues[0].items.filter((i) => i.price_is_from).length > 0,
    true,
    "the pickup-priced Steglitz venue carries starting prices; its quoted total is a floor",
  );
});
