/**
 * venue_announcement_test.ts — S4a glue tests.
 *
 * Covers the mapping (venue.json -> AnnounceInput) and the emit path via the
 * vendored emitter. Run: deno task test
 */

import { emitAnnouncement, emitAnnouncementTags, parseVocab, recomputeTier, type Vocab } from "../vendor/cvm-service-kit/src/mod.ts";
import { venueToAnnouncement, type VenueRecord } from "../tools/venue_to_announcement.ts";
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

    // the FLOW asks for a delivery address + phone (both venues deliver)
    assert((input.required ?? []).includes("ship.address"), `${slug}: ship.address required`);
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

Deno.test("geohash: reference point and invalid inputs", () => {
  assertEquals(encodeGeohash(52.52, 13.405, 8), "u33dc0cp", "Berlin reference");
  assertThrows(() => encodeGeohash(NaN, 13, 4), "finite");
  assertThrows(() => encodeGeohash(52.5, 13.4, 0), "precision");
  assertThrows(() => encodeGeohash(52.5, 13.4, 13), "precision");
});
