/**
 * e2e_client_test.ts — the client's per-venue expectations come from the
 * COMMITTED anchor (`venues/anchors.json`), not from the records it serves.
 *
 * Card t_a640b7ca measured that the client used to carry a hard-coded VENUE_CFG
 * table, so capturing a new venue required editing a code file. Deriving the
 * expectations from `venues/` fixed that and BROKE the verification: the
 * expectation was computed by the same expression over the same files as the
 * server's own reply, so any record passed — including a fabricated
 * `venues/<slug>/venue.json` with no evidence and invented prices (41 passed, 0
 * failed with it in the tree).
 *
 * These tests pin the replacement: the expectation is a committed datum. It
 * still needs no code edit to onboard a venue (the anchor is data), but it
 * cannot agree with a bad record.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveVenueCfg, servedVenueReplyHash } from "./e2e_client.ts";
import { ANCHOR_URL, readAnchor, servedVenueHash } from "./anchor.ts";
import { discoverVenueSlugs, loadVenues, servedVenueProjection } from "./server.ts";

Deno.test("the client covers exactly the venue set the committed anchor declares", async () => {
  const anchor = await readAnchor();
  const cfg = await deriveVenueCfg();
  assertEquals(
    Object.keys(cfg).sort(),
    [...anchor.served_venues].sort(),
    "the client's expectations and the committed anchor must name the same venues — " +
      "a missing one means a record changed without regenerating venues/anchors.json",
  );
});

Deno.test("the anchor covers exactly the venue records on disk (drift guard)", async () => {
  const slugs = await discoverVenueSlugs();
  const anchor = await readAnchor();
  const servedByServer = new Set((await loadVenues()).map((v) => v.slug));
  assertEquals(
    [...anchor.served_venues].sort(),
    [...slugs].filter((s) => servedByServer.has(s)).sort(),
    "venues/anchors.json is a committed expectation: adding or removing a venue record is a " +
      "change to it (deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write)",
  );
});

Deno.test("the expectation's item count is the ANCHOR's, not a value re-derived from the record", async () => {
  const anchor = await readAnchor();
  const cfg = await deriveVenueCfg();
  assert(Object.keys(anchor.venues).length > 0, "the anchor declares no venues");
  for (const [slug, entry] of Object.entries(anchor.venues)) {
    assertEquals(
      cfg[slug]?.items,
      entry.item_count,
      `${slug}: the client must expect the committed count`,
    );
  }
  // The anchor also carries the content hash the e2e client compares the live
  // reply against; an expectation without one could not fail on an edited record.
  for (const [slug, entry] of Object.entries(anchor.venues)) {
    assertEquals(
      /^[0-9a-f]{64}$/.test(entry.menu_sha256),
      true,
      `${slug}: the anchor must carry a sha256 of the venue's served projection`,
    );
  }
});

Deno.test("the anchor is committed, not generated at read time", async () => {
  const text = await Deno.readTextFile(ANCHOR_URL);
  assert(
    text.includes('"generated_by": "venues/tools/menu_anchors.ts"'),
    "venues/anchors.json must be the generator's committed output",
  );
  const anchor = JSON.parse(text);
  assertEquals(
    anchor.menu_sha256?.length,
    64,
    "the whole-catalogue hash must be committed alongside the per-venue ones",
  );
});

Deno.test("the derived basket names two orderable lines of that venue's own menu", async () => {
  const cfg = await deriveVenueCfg();
  for (const v of await loadVenues()) {
    const order = cfg[v.slug].order;
    assertEquals(order.venue_slug, v.slug);
    assert(
      v.order_methods.includes(order.fulfilment) ||
        !v.order_methods.some((m) => m === "pickup" || m === "dine_in"),
      `${v.slug}: fulfilment '${order.fulfilment}' must be one the venue declares (${v.order_methods.join(", ")})`,
    );
    const lines = order.items as Array<{ sku?: string; id?: string; qty: number }>;
    assert(lines.length > 0, `${v.slug}: a basket must be derived`);
    for (const line of lines) {
      const item = line.sku !== undefined
        ? v.items.filter((i) => i.sku === line.sku)
        : v.items.filter((i) => i.id === String(line.id));
      assertEquals(
        item.length,
        1,
        `${v.slug}: line ${JSON.stringify(line)} must identify exactly one item by a unique identity`,
      );
      assertEquals(item[0].available, true, `${v.slug}: an unavailable item is not orderable`);
      assertEquals(item[0].option_group_ids.length, 0, `${v.slug}: an item with options needs choices the client cannot invent`);
      assert(line.qty >= 1, `${v.slug}: qty must be positive`);
    }
  }
});

Deno.test("the three Steglitz venues are covered with no client edit", async () => {
  const cfg = await deriveVenueCfg();
  for (const slug of ["chandi-berlin", "doreedos-steakhaus-berlin", "la-mama-berlin"]) {
    assert(cfg[slug], `${slug} must have a committed expectation without touching this client`);
  }
});

// ---------------------------------------------------------------------------
// REGRESSION (found 2026-10-12 by a LIVE e2e run, not by the suite):
//
// The generator hashed the BARE projection — `sha256(canonicalJson(projection))`
// — while the client compared the WRAPPED one — `sha256(servedCatalogueText(
// [reply], total))`, i.e. `{total_items, venues:[projection]}`. Structurally
// different objects, so the client's per-venue hash could NEVER equal the
// committed `menu_sha256`. The suite stayed green because the CATALOGUE-level
// check wraps the same way on both sides, and `server_test.ts` recomputed the
// bare form against the bare form. Consequence: every live single-venue e2e run
// reported `sha256=<served>!=<anchor>` while the record was byte-correct — a
// false failure that would have trained the operator to ignore the one check
// that proves the served record is the anchored one.
//
// The fix is one shared hasher (`servedVenueHash` in anchor.ts). This test
// pins the round-trip the suite lacked: the hash the CLIENT expects for a venue
// must equal the hash the GENERATOR commits for it.
// ---------------------------------------------------------------------------
Deno.test("REGRESSION: the client's per-venue hash equals the anchor generator's — one hasher, not two", async () => {
  const anchor = await readAnchor();
  for (const slug of anchor.served_venues) {
    const served = servedVenueProjection((await loadVenues([slug]))[0]);
    const fromGenerator = await servedVenueHash(served);
    const fromClient = await servedVenueReplyHash(served);
    assertEquals(
      fromGenerator,
      fromClient,
      `${slug}: the generator and the client must hash the venue the SAME way — ` +
        `a bare-projection hash and a wrapped-catalogue hash are different objects ` +
        `and the comparison can never pass (this was the 2026-10-12 live e2e false failure)`,
    );
    assertEquals(
      fromClient,
      anchor.venues[slug].menu_sha256,
      `${slug}: the client's expectation must equal the committed anchor entry`,
    );
  }
});
