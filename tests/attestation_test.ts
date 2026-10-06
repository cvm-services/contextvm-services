/**
 * Tests for venue attestations (R4a, kind 30317).
 *
 * Two of these are the reason the file exists:
 *
 *   1. A venue cannot attest for itself as the reviewer — a self-signed
 *      "confirmation" is the cheapest forgery and must not be constructible.
 *   2. The kind guard refuses the replaceable range. A venue that could hold only
 *      ONE attestation network-wide would silently erase its own earlier vouches,
 *      which is the bug that already bit the announcements (kind 11317).
 */

import {
  ATTESTATION_CLASS,
  ATTESTATION_KIND,
  ATTESTATION_TYPE_VENUE_SIGNED,
  assertNotReplaceable,
  attestationD,
  buildAttestation,
} from "../tools/attestation_event.ts";

const VENUE = "ae317038b9c8c2fb681b163e9903d179785292b95d964dcb89bd053ba83e84bd";
const REVIEWER = "4e5970390303ed7c17be1d5f2656b6a7edf8ca9c2e97796bed97956ba578a50d";
const REVIEW_ID = "95ffbfe506e79bacbef91a295b540f449b1cdfddd428380bbfbf901cd2dc848a";

function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(c: unknown, what: string) {
  if (!c) throw new Error(what);
}
function throws(fn: () => unknown, contains: string, what: string) {
  try {
    fn();
  } catch (e) {
    const m = (e as Error).message;
    if (!m.includes(contains)) throw new Error(`${what}: wrong error: ${m}`);
    return;
  }
  throw new Error(`${what}: expected a throw`);
}

const base = {
  venue_slug: "doppelt-kaese-berlin",
  reviewer_pubkey: REVIEWER,
  provider_pubkey: VENUE,
  claim: "This reviewer placed an order at this venue.",
  created_at: 1791227500,
};

Deno.test("attestation: built with the documented tags, bound to the announcement", () => {
  const ev = buildAttestation({ ...base, review_event_id: REVIEW_ID });
  eq(ev.kind, ATTESTATION_KIND, "kind");
  eq(ev.tags[0], ["d", attestationD("doppelt-kaese-berlin", REVIEWER)], "d is venue:reviewer");
  eq(ev.tags[1], ["a", `11317:${VENUE}:doppelt-kaese-berlin`], "bound to the announcement coordinate");
  eq(ev.tags[2], ["p", REVIEWER], "names the reviewer");
  ok(ev.tags.some((t) => t[0] === "t" && t[1] === ATTESTATION_CLASS), "class tag present");
  ok(ev.tags.some((t) => t[0] === "t" && t[1] === ATTESTATION_TYPE_VENUE_SIGNED), "type tag present");
  eq(ev.tags[5], ["e", REVIEW_ID, "", "review"], "review reference");
  eq(ev.content, base.claim, "claim is the content, unaltered");
});

Deno.test("attestation: the review reference is optional", () => {
  const ev = buildAttestation(base);
  eq(ev.tags.filter((t) => t[0] === "e").length, 0, "no e tag when not given");
  ok(ev.tags.length === 5, `expected 5 tags, got ${ev.tags.length}`);
});

Deno.test("attestation: a venue cannot attest for itself as the reviewer", () => {
  throws(
    () => buildAttestation({ ...base, reviewer_pubkey: VENUE }),
    "cannot attest for itself",
    "self-attestation must be refused",
  );
});

Deno.test("attestation: the replaceable range is refused — the 11317 trap", () => {
  throws(() => assertNotReplaceable(11317), "replaceable", "11317");
  throws(() => assertNotReplaceable(11318), "replaceable", "11318");
  throws(() => assertNotReplaceable(10000), "replaceable", "lower bound");
  throws(() => assertNotReplaceable(19999), "replaceable", "upper bound");
  // and the kind we actually use must pass
  assertNotReplaceable(ATTESTATION_KIND);
  assertNotReplaceable(30316);
});

Deno.test("attestation: malformed inputs are refused, not coerced", () => {
  throws(() => buildAttestation({ ...base, venue_slug: "Doppelt Käse" }), "kebab slug", "bad slug");
  throws(() => buildAttestation({ ...base, reviewer_pubkey: "nothex" }), "64-char", "bad reviewer");
  throws(() => buildAttestation({ ...base, provider_pubkey: "AB".repeat(32) }), "64-char", "uppercase provider");
  throws(() => buildAttestation({ ...base, claim: "   " }), "must not be empty", "empty claim");
  throws(() => buildAttestation({ ...base, created_at: 0 }), "unix seconds", "zero timestamp");
  throws(() => buildAttestation({ ...base, review_event_id: "short" }), "64-char hex", "bad review id");
});

Deno.test("attestation: (venue, reviewer) is the identity — two reviewers do not collide", () => {
  const other = "87c3a21fd09fe893a22f10b404d4953ce95d1c9e2fded64c37d3acaab65b82d9";
  const a = buildAttestation(base).tags[0][1];
  const b = buildAttestation({ ...base, reviewer_pubkey: other }).tags[0][1];
  ok(a !== b, "different reviewers must occupy different coordinates");
  eq(a, "doppelt-kaese-berlin:" + REVIEWER, "coordinate shape");
});
