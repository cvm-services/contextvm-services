/**
 * venue_announcement_test.ts — S4a glue tests.
 *
 * Covers the mapping (venue.json -> AnnounceInput) and the emit path via the
 * vendored emitter. Run: deno task test
 */

import {
  assessAnnouncementTags,
  emitAnnouncement,
  emitAnnouncementTags,
  parseVocab,
  recomputeTier,
  type Vocab,
} from "../vendor/cvm-service-kit/src/mod.ts";
import {
  venuePayloadTags,
  venueToAnnouncement,
  venueWireTags,
  type VenueRecord,
} from "../tools/venue_to_announcement.ts";
import { encodeGeohash } from "../tools/geohash.ts";

const VOCAB: Vocab = parseVocab(
  JSON.parse(await Deno.readTextFile(new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url))),
);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}
function assertThrows(fn: () => unknown, contains: string) {
  try {
    fn();
  } catch (err) {
    if (!(err as Error).message.includes(contains)) {
      throw new Error(`ASSERT (throw message): got '${(err as Error).message}', want '${contains}'`);
    }
    return;
  }
  throw new Error(`ASSERT (expected throw containing '${contains}'): nothing thrown`);
}

/** Load the venue record the S1 adapters committed (venues/<slug>/venue.json). */
async function loadVenue(slug: string): Promise<VenueRecord> {
  return JSON.parse(await Deno.readTextFile(new URL(`../venues/${slug}/venue.json`, import.meta.url)));
}

const DOPPELT = "doppelt-kaese-berlin";
const PIZZA = "pizza-e-pasta-ruedesheimerplatz";

Deno.test("RED: an unknown cvm:req:* field name is refused, not silently kept", () => {
  // The glue must NOT let an unknown field through to the wire. Feed the
  // vendored emitter a field the register does not know and assert it refuses.
  assertThrows(
    () => emitAnnouncementTags(
      { serviceClass: "restaurant", d: "x", required: ["mystery.field"] },
      VOCAB,
    ),
    "unknown requirement field",
  );
});

Deno.test("both venue records emit deterministic tags", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const { input } = venueToAnnouncement(v);
    const a = emitAnnouncementTags(input, VOCAB).tags;
    const b = emitAnnouncementTags(input, VOCAB).tags;
    assertEquals(a, b, `${slug}: stable tag order`);

    // exactly one class tag
    assertEquals(
      a.filter((t) => t[0] === "t" && t[1] === "cvm:service:restaurant").length,
      1,
      `${slug}: one class tag`,
    );
  }
});

Deno.test("tier tag equals the recomputed max; never supplied by the caller", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const { input } = venueToAnnouncement(v);
    // AnnounceInput has no tier field — the emitter computes it.
    assert(!("tier" in input), `${slug}: caller has no tier field`);

    const emitted = emitAnnouncement(input, VOCAB);
    const rec = recomputeTier(
      { required: input.required ?? [], optional: input.optional ?? [], noneSentinel: false, unclassified: false },
      VOCAB,
    );
    assertEquals(emitted.tier, rec.tier, `${slug}: emitted == recomputed`);

    const tierTags = emitted.tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:tier:"));
    assertEquals(tierTags.length, 1, `${slug}: exactly one tier tag`);
    assertEquals(tierTags[0][1], `cvm:tier:${rec.tier}`, `${slug}: tier tag value`);
    // ship.address (fulfilment) is required -> tier must be at least fulfilment
    assert(rec.tier === "fulfilment", `${slug}: expected fulfilment, got ${rec.tier}`);
  }
});

Deno.test("two or more geohash precisions of ONE point", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const { input } = venueToAnnouncement(v);
    const gs = input.geohashes ?? [];
    assert(gs.length >= 2, `${slug}: >= 2 precisions, got ${gs.length}`);
    // each longer is a prefix-extension of the previous
    for (let i = 1; i < gs.length; i++) {
      assert(gs[i].startsWith(gs[i - 1]), `${slug}: ${gs[i]} extends ${gs[i - 1]}`);
    }
    // the point matches the venue's lat/lon at the finest precision
    const finest = encodeGeohash(v.venue.address!.lat!, v.venue.address!.lon!, 8);
    assert(gs[gs.length - 1] === finest, `${slug}: finest precision matches lat/lon`);
  }
});

Deno.test("exactly one cap per tool, and the flow's required fields are declared", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const { input } = venueToAnnouncement(v);
    const caps = emitAnnouncementTags(input, VOCAB).tags.filter((t) => t[0] === "cap");
    assertEquals(caps.length, Object.keys(input.tools ?? {}).length, `${slug}: one cap per tool`);
    assertEquals(caps[0][1], "tool:order", `${slug}: the order tool`);

    // Both venues ALSO do pickup, so the address is an accepted field, not a
    // requirement: the customer picks fulfilment first and only a delivery order
    // needs an address. Fixed 2026-10-06 — the assertion that used to live here
    // (`ship.address required`) encoded a false claim about the appetite.
    assert(!(input.required ?? []).includes("ship.address"), `${slug}: no required address`);
    assert((input.optional ?? []).includes("ship.address"), `${slug}: address accepted`);
    assert((input.required ?? []).includes("order.fulfilment"), `${slug}: fulfilment is the choice`);
    assert((input.required ?? []).includes("contact.phone"), `${slug}: contact.phone required`);
    // the deep-link is carried as `r`
    assert((input.urls ?? []).length >= 1, `${slug}: has a deep-link r`);
  }
});

Deno.test("--dry-run output is byte-stable across runs (same sha256)", async () => {
  const { crypto } = globalThis;
  async function dryRunJson(slug: string): Promise<string> {
    const v = await loadVenue(slug);
    const { input, content } = venueToAnnouncement(v);
    const emitted = emitAnnouncement(input, VOCAB);
    return JSON.stringify({
      kind: 11317,
      tags: emitted.tags,
      content: JSON.stringify({ tools: (content as { tools: unknown }).tools }),
      tier: emitted.tier,
    });
  }
  async function sha256(s: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  for (const slug of [DOPPELT, PIZZA]) {
    const h1 = await sha256(await dryRunJson(slug));
    const h2 = await sha256(await dryRunJson(slug));
    assertEquals(h1, h2, `${slug}: dry-run sha256 stable`);
  }
});

// --- fulfilment methods and the price they imply (2026-10-06) -------------
//
// Both venues offer pickup AND delivery. The announcement used to require
// `ship.address` unconditionally, which is false for a pickup order and inflates
// the declared appetite (register rule 2). The price list has the same shape of
// problem: 72 of 76 doppelt items are CHEAPER on pickup (Cheeseburger: 8.90
// pickup vs 9.50 delivery), so a single min/max taken from `price` silently
// reports the delivery column.

Deno.test("RED: a pickup-capable venue declares no required address", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    assert(
      (v.venue.order_methods ?? []).includes("pickup"),
      `${slug}: fixture is pickup-capable (venue.json says so)`,
    );
    const { input } = venueToAnnouncement(v);
    const tags = emitAnnouncementTags(input, VOCAB).tags;
    const req = tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:req:")).map((t) => t[1]);
    const opt = tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:opt:")).map((t) => t[1]);
    assert(!req.includes("cvm:req:ship.address"), `${slug}: no required address, got ${JSON.stringify(req)}`);
    assert(opt.includes("cvm:opt:ship.address"), `${slug}: the address is accepted (delivery only)`);
    assert(req.includes("cvm:req:order.fulfilment"), `${slug}: pickup-vs-delivery is the choice`);
  }
});

Deno.test("RED: a delivery-only venue still requires an address (the rule is per venue)", () => {
  const deliveryOnly = {
    slug: "only-delivery",
    venue: {
      name: "Only Delivery",
      order_methods: ["delivery"],
      website: "https://only-delivery.example",
      address: { lat: 52.5, lon: 13.4 },
      ordering: { primary_url: "https://only-delivery.example/order" },
    },
  } as VenueRecord;
  const { input } = venueToAnnouncement(deliveryOnly);
  assert(
    (input.required ?? []).includes("ship.address"),
    "a delivery-only venue keeps ship.address required",
  );
  assert(
    !(input.optional ?? []).includes("ship.address"),
    "...and does not also list the same field as optional",
  );
});

Deno.test("RED: the advertised price names the fulfilment method it belongs to", async () => {
  const v = await loadVenue(DOPPELT);
  const menu = (venueToAnnouncement(v).content as { menu: Record<string, unknown> }).menu;
  const byMethod = menu.prices_by_method as Record<string, { min_price: number; max_price: number; count: number }>;
  assert(byMethod?.pickup && byMethod?.delivery, "both methods are priced separately");
  assert(
    byMethod.pickup.max_price < byMethod.delivery.max_price,
    `pickup is cheaper here (doppelt: 72/76 items) — got ${byMethod.pickup.max_price} vs ${byMethod.delivery.max_price}`,
  );
  assert(
    typeof menu.price_basis === "string" && (menu.price_basis as string).length > 10,
    "the announcement says what its headline min/max means",
  );
});

Deno.test("RED: the announcement states the methods it offers and the pickup wait", async () => {
  interface FulfilmentContent {
    methods: string[];
    pickup?: { available?: boolean; estimated_minutes?: number };
    delivery?: { available?: boolean } | null;
    method_condition: string;
  }
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const content = venueToAnnouncement(v).content as { fulfilment: FulfilmentContent };
    const f = content.fulfilment;
    assert(f.methods.includes("pickup") && f.methods.includes("delivery"), `${slug}: methods declared`);
    assert(
      typeof f.pickup?.estimated_minutes === "number",
      `${slug}: the pickup wait is carried through (venue.json has it, the wire did not)`,
    );
    // the condition the flat AND register cannot express must be written out
    assert(
      /address/i.test(f.method_condition) && /(pickup|delivery)/i.test(f.method_condition),
      `${slug}: says when an address is needed`,
    );
  }
});

Deno.test("RED: the rail is the venue's own, and no Lightning claim is made", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const c = JSON.stringify(venueToAnnouncement(v).content);
    assert(/venue's own rail/.test(c), `${slug}: says who settles`);
    assert(!/bitcoin-lightning-bolt11|bolt11/i.test(c), `${slug}: no Lightning claim`);
  }
  const d = await loadVenue(DOPPELT);
  assert(
    /adyen|stripe|paypal|cash/i.test(JSON.stringify(venueToAnnouncement(d).content)),
    "doppelt: the adapter-recorded rail is carried through",
  );
});

Deno.test("geohash: reference point and invalid inputs", () => {
  assertEquals(encodeGeohash(52.52, 13.405, 8), "u33dc0cp", "Berlin reference");
  assertThrows(() => encodeGeohash(NaN, 13, 4), "finite");
  assertThrows(() => encodeGeohash(52.5, 13.4, 0), "precision");
  assertThrows(() => encodeGeohash(52.5, 13.4, 13), "precision");
});

// --- S5a §6 payload tags: what the registry reads for display -------------
//
// The dashboard card renders `e.name ?? e.d` (cvm-registry site/app.js:317) and
// the collector fills `name` from tagValues(tags, "name") — the TAG, not the
// content (collector/lib.ts:413). The nosms reference appends PAYLOAD_TAGS for
// exactly this reason (tools/nosms_announcement.ts, `payload_tags`); the venue
// path never appended anything, so both venue cards fell back to the slug.

/** Every value of tag `k`, the way the registry's collector reads them. */
function tagValues(tags: string[][], k: string): string[] {
  return tags.filter((t) => Array.isArray(t) && t[0] === k).map((t) => String(t[1]));
}

Deno.test("RED: the published announcement carries the 'name' tag the registry reads", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const evidenceUrl = new URL(`../evidence/announcements/${slug}.11317.json`, import.meta.url);
    const ev = JSON.parse(await Deno.readTextFile(evidenceUrl));
    const names = tagValues(ev.tags, "name");
    assert(
      names.length === 1,
      `${slug}: the published 11317 carries exactly one 'name' tag, got ${JSON.stringify(names)}`,
    );
    assertEquals(names[0], v.venue?.name, `${slug}: the tag is the venue's own name`);
  }
});

Deno.test("RED: the wire tag set appends name/about/website without disturbing the contract", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const a = venueToAnnouncement(v);
    const emitted = emitAnnouncement(a.input, VOCAB);
    const wire = venueWireTags(emitted.tags, v);

    assertEquals(
      wire.slice(0, emitted.tags.length),
      emitted.tags,
      `${slug}: the kit's contract tags are untouched and keep their order`,
    );
    assertEquals(
      wire.length - emitted.tags.length,
      venuePayloadTags(v).length,
      `${slug}: payload tags are appended`,
    );

    const name = tagValues(wire, "name");
    assert(name.length === 1, `${slug}: exactly one 'name'`);
    assertEquals(name[0], v.venue?.name, `${slug}: name is the venue's name, not the slug`);
    assert(name[0] !== slug, `${slug}: the slug is not the display name`);

    const about = tagValues(wire, "about");
    assert(about.length === 1 && about[0].length > 20, `${slug}: an 'about' line`);
    const website = tagValues(wire, "website");
    assert(website.length === 1 && /^https?:\/\//.test(website[0]), `${slug}: a 'website' URL`);

    // The validator ignores tag letters it does not own, so appending must keep
    // the full set conforming and the tier recomputing — asserted, not assumed.
    const assessment = assessAnnouncementTags(wire, VOCAB);
    assertEquals(assessment.violations, [], `${slug}: no violations on the full set`);
    assertEquals(assessment.tierMismatch, false, `${slug}: the tier still recomputes`);

    // one definition of the payload tags, so the tag and the content cannot drift
    const contentAbout = (a.content as { about: string }).about;
    assertEquals(about[0], contentAbout, `${slug}: the tag's about IS the content's about`);
  }
});


// --- the meatspace class tag (2026-10-06) ---------------------------------
//
// "Meatspace" is a CAPABILITY, not a business type: it says the goods change
// hands in person. A restaurant is meatspace when it does pickup and not when it
// delivers only. It rides the existing class channel as an extra tag next to the
// primary `restaurant` class, so any client filtering `cvm:service:meatspace`
// finds it without a register change of its own.
//
// It must NOT be derived from "requires no shipping address" alone: every
// digital service (cvm-lambda, nosms) also requires no address, and classing
// them as in-person handover would be a false claim on the very facet buyers
// would use to find a shop they can walk into.

Deno.test("RED: a pickup-capable venue is classed meatspace, a delivery-only one is not", async () => {
  for (const slug of [DOPPELT, PIZZA]) {
    const v = await loadVenue(slug);
    const classes = tagValues(emitAnnouncement(venueToAnnouncement(v).input, VOCAB).tags, "t")
      .filter((w) => w.startsWith("cvm:service:"));
    assert(
      classes.includes("cvm:service:meatspace"),
      `${slug}: expected the meatspace class, got ${JSON.stringify(classes)}`,
    );
    assertEquals(classes[0], "cvm:service:restaurant", `${slug}: the primary class stays first`);
  }
  const deliveryOnly = {
    slug: "only-delivery",
    venue: {
      name: "Only Delivery",
      order_methods: ["delivery"],
      delivery: { available: true },
      address: { lat: 52.5, lon: 13.4 },
      ordering: { primary_url: "https://x.example/o" },
    },
  } as unknown as VenueRecord;
  const classes = tagValues(emitAnnouncement(venueToAnnouncement(deliveryOnly).input, VOCAB).tags, "t")
    .filter((w) => w.startsWith("cvm:service:"));
  assert(
    !classes.includes("cvm:service:meatspace"),
    `delivery-only must not claim in-person handover, got ${JSON.stringify(classes)}`,
  );
});

Deno.test("RED: the kit emits extra classes deterministically and rejects malformed ones", () => {
  const t = (x: Parameters<typeof emitAnnouncement>[0]) =>
    emitAnnouncement(x, VOCAB).tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);
  assertEquals(
    t({ serviceClass: "restaurant", d: "x", extraClasses: ["meatspace", "meatspace", "ev-charger"] })
      .slice(0, 3),
    ["cvm:service:restaurant", "cvm:service:ev-charger", "cvm:service:meatspace"],
    "primary first, extras sorted, duplicates dropped",
  );
  assertThrows(
    () => emitAnnouncement({ serviceClass: "restaurant", d: "x", extraClasses: ["cvm:service:x"] }, VOCAB),
    "not a short lowercase kebab token",
  );
  assertThrows(
    () => emitAnnouncement({ serviceClass: "restaurant", d: "x", extraClasses: ["Meat Space"] }, VOCAB),
    "not a short lowercase kebab",
  );
});
