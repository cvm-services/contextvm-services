/**
 * Tests for the review event shape (R1).
 *
 * The load-bearing assertions here are the two that would be silent in
 * production: that the rating is reachable through a SINGLE-LETTER tag (spec
 * P2 — multi-letter tags are payload, relays do not index them), and that the
 * kind can never drift into NIP-16's replaceable range, where relays key by
 * (kind, pubkey) alone and every review by one author would overwrite the last.
 */

import {
  ANNOUNCE_TOOLS_KIND,
  announcementCoordinate,
  assertNotReplaceable,
  buildReviewEvent,
  RATING_MAX,
  REPLACEABLE_RANGE,
  REVIEW_KIND,
  reviewCoordinate,
} from "../tools/review_event.ts";

const PROVIDER = "ae317038b9c8c2fb681b163e9903d179785292b95d964dcb89bd053ba83e84bd";

function input(over: Record<string, unknown> = {}) {
  return {
    venue_slug: "doppelt-kaese-berlin",
    provider_pubkey: PROVIDER,
    venue_url: "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase",
    rating: 5,
    geohashes: ["u33d", "u33dc0"],
    content: "  Best Käse in Kreuzberg.  ",
    created_at: 1791223666,
    ...over,
  };
}

function throws(fn: () => unknown, what: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`expected a throw: ${what}`);
}

function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: got ${actual}, want ${expected}`);
}

function tag(tags: string[][], name: string): string[] | undefined {
  return tags.find((t) => t[0] === name);
}

Deno.test("review: binds to the announcement coordinate, slug and deep-link", () => {
  const ev = buildReviewEvent(input());
  eq(ev.kind, REVIEW_KIND, "kind");
  eq(tag(ev.tags, "d")?.[1], "doppelt-kaese-berlin", "d");
  eq(
    tag(ev.tags, "a")?.[1],
    `${ANNOUNCE_TOOLS_KIND}:${PROVIDER}:doppelt-kaese-berlin`,
    "a coordinates",
  );
  eq(tag(ev.tags, "a")?.[1], announcementCoordinate(PROVIDER, "doppelt-kaese-berlin"), "a helper");
  eq(tag(ev.tags, "r")?.[1], "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase", "r");
  eq(tag(ev.tags, "p")?.[1], PROVIDER, "p = reviewed provider");
  eq(ev.content, "Best Käse in Kreuzberg.", "content is trimmed");
  eq(ev.created_at, 1791223666, "created_at is passed through, never invented in the builder");
});

Deno.test("review: rating is filterable via single-letter tags only", () => {
  const ev = buildReviewEvent(input({ rating: 4 }));
  const ts = ev.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  if (!ts.includes("cvm:review")) throw new Error("missing cvm:review class tag");
  if (!ts.includes("cvm:rating:4")) {
    throw new Error(`rating not reachable via #t: got ${JSON.stringify(ts)}`);
  }
  eq(tag(ev.tags, "L")?.[1], "cvm.rating", "L namespace");
  eq(tag(ev.tags, "l")?.[1], "4", "l value");
  eq(tag(ev.tags, "l")?.[2], "cvm.rating", "l namespace");
  // the human tag is payload: present, but nothing may depend on it
  eq(tag(ev.tags, "rating")?.[1], "4", "payload rating");
  eq(tag(ev.tags, "rating")?.[2], String(RATING_MAX), "payload scale");
});

Deno.test("review: geohashes are carried, one tag each, at least one required", () => {
  const ev = buildReviewEvent(input());
  const gs = ev.tags.filter((t) => t[0] === "g").map((t) => t[1]);
  eq(JSON.stringify(gs), JSON.stringify(["u33d", "u33dc0"]), "g tags");
  throws(() => buildReviewEvent(input({ geohashes: [] })), "no geohash");
  throws(() => buildReviewEvent(input({ geohashes: ["UPPER"] })), "bad geohash charset");
});

Deno.test("review: the kind cannot drift into the replaceable range", () => {
  if (REVIEW_KIND >= REPLACEABLE_RANGE[0] && REVIEW_KIND < REPLACEABLE_RANGE[1]) {
    throw new Error(`REVIEW_KIND ${REVIEW_KIND} is replaceable — reviews would overwrite`);
  }
  // the announcement family IS in that range: that is exactly why reviews are not
  throws(() => assertNotReplaceable(11318), "11318 must be rejected");
  throws(() => assertNotReplaceable(11320), "11320 must be rejected");
  assertNotReplaceable(REVIEW_KIND); // must not throw
});

Deno.test("review: rejects malformed input instead of publishing it", () => {
  throws(() => buildReviewEvent(input({ rating: 0 })), "rating below range");
  throws(() => buildReviewEvent(input({ rating: 6 })), "rating above range");
  throws(() => buildReviewEvent(input({ rating: 4.5 })), "non-integer rating");
  throws(() => buildReviewEvent(input({ content: "   " })), "blank content");
  throws(() => buildReviewEvent(input({ venue_slug: "Doppelt Käse" })), "slug");
  throws(() => buildReviewEvent(input({ venue_url: "javascript:alert(1)" })), "non-http url");
  throws(() => buildReviewEvent(input({ provider_pubkey: "nothex" })), "provider pubkey");
  throws(() => buildReviewEvent(input({ announcement_event_id: "abc" })), "announcement id");
  throws(() => buildReviewEvent(input({ created_at: 0 })), "created_at");
});

Deno.test("review: the optional announcement id is an 'e' tag with a marker", () => {
  const id = "8924044ead30ede3" + "0".repeat(48);
  const ev = buildReviewEvent(input({ announcement_event_id: id }));
  const e = tag(ev.tags, "e");
  eq(e?.[1], id, "e value");
  eq(e?.[3], "announcement", "e marker");
  eq(buildReviewEvent(input()).tags.filter((t) => t[0] === "e").length, 0, "absent when not given");
});

Deno.test("review: coordinate is per reviewer per venue (no cross-reviewer collisions)", () => {
  const a = reviewCoordinate(PROVIDER, "doppelt-kaese-berlin", "a".repeat(64));
  const b = reviewCoordinate(PROVIDER, "doppelt-kaese-berlin", "b".repeat(64));
  const c = reviewCoordinate(PROVIDER, "pizza-e-pasta-ruedesheimerplatz", "a".repeat(64));
  if (a === b) throw new Error("two reviewers collapsed to one coordinate");
  if (a === c) throw new Error("two venues collapsed to one coordinate");
  if (!a.startsWith(String(REVIEW_KIND))) throw new Error("coordinate must carry the kind");
});
