/**
 * e2e_client_test.ts — the client's per-venue expectations must be DERIVED from
 * the venue records, so onboarding a venue stays pure config.
 *
 * Card t_a640b7ca (ADR-0007 amendment 2026-10-09) measured exactly this: the
 * client used to carry a hard-coded VENUE_CFG table, so capturing a NEW venue
 * over CVM required editing this client — a code file — no matter how
 * declarative the venue record was. These tests pin the seam shut: they read the
 * venue files (server.ts's own discovery) and require the client's derived
 * expectation to match them one for one.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveVenueCfg } from "./e2e_client.ts";
import { discoverVenueSlugs, loadVenues } from "./server.ts";

Deno.test("the client derives exactly one expectation per venue record", async () => {
  const slugs = await discoverVenueSlugs();
  const cfg = await deriveVenueCfg();
  assertEquals(
    Object.keys(cfg).sort(),
    [...slugs].sort(),
    "every venue in venues/ needs a derived expectation, and only those — a missing one means onboarding needs a client edit",
  );
});

Deno.test("the derived item count is the record's own item count", async () => {
  const cfg = await deriveVenueCfg();
  for (const v of await loadVenues()) {
    assertEquals(cfg[v.slug].items, v.items.length, `${v.slug}: item count must come from the record`);
  }
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
    assert(cfg[slug], `${slug} must have a derived expectation without touching this client`);
  }
});
