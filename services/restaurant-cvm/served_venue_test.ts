/**
 * The `menu` tool must publish the venue's hand-off URL and rail.
 *
 * Why: the facilitator console shows "no venue checkout URL declared" and the
 * only honest fix is for the venue's own ordering URL to reach it. That URL is
 * computed once, in `loadVenues` (ordering.primary_url ?? website), and served
 * by the `quote` tool as `venue.deep_link`. The `menu` tool — the one the
 * capture uses for menu.json, which becomes the orders catalog — dropped it, so
 * the value was unavailable anywhere downstream.
 *
 * The projection test pins the carry-through, including the refusal to invent a
 * URL when the venue record has none.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { servedVenueProjection, type Venue } from "./server.ts";

function venue(overrides: Partial<Venue> = {}): Venue {
  return {
    slug: "three-buddies-berlin",
    name: "Three Buddies",
    currency: "EUR",
    deep_link: "https://threebuddies.online-karte.com/threebuddies",
    rail: "unknown",
    order_methods: ["pickup"],
    items: [],
    adapter: null,
    captured_at: null,
    ...overrides,
  };
}

Deno.test("the menu projection carries the venue's deep_link", () => {
  const served = servedVenueProjection(venue());
  assertEquals(served.deep_link, "https://threebuddies.online-karte.com/threebuddies");
});

Deno.test("the menu projection carries the venue's rail", () => {
  const served = servedVenueProjection(venue({ rail: "adyen/stripe (venue's own)" }));
  assertEquals(served.rail, "adyen/stripe (venue's own)");
});

Deno.test("a venue with no hand-off URL projects deep_link as null, never invented", () => {
  const served = servedVenueProjection(venue({ deep_link: "", rail: null }));
  assertEquals(served.deep_link, null, "empty must become null, not a guess");
  assertEquals(served.rail, null);
});

Deno.test("the projection never mutates the source venue", () => {
  const v = venue();
  servedVenueProjection(v);
  assertEquals(v.deep_link, "https://threebuddies.online-karte.com/threebuddies");
  assert(v.items.length === 0);
});
