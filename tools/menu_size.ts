/**
 * menu_size.ts — how big is the served `menu` reply, in each of the two shapes the
 * option groups could take?  The reply travels as ONE gift-wrapped Nostr event, so
 * this number decides whether the groups are deliverable at all
 * (evidence/relay-e2e/FINDING-3-menu-frame-exceeds-relay-cap.md).
 *
 *   catalogue form (what ships): the groups once per venue, plus per item the group
 *     ids it offers and its own price level — R6 of tools/venue_option_groups.ts
 *   per-item form (rejected): every item carrying its own resolved copy of every
 *     group it offers, each choice priced for that item — the literal reading of
 *     PLAN-0006 AC1
 *
 * Run: deno run --allow-read tools/menu_size.ts
 */
import { handleToolCall, loadVenues } from "../services/restaurant-cvm/server.ts";
import { priceForItem, priceKeyOf } from "./venue_option_groups.ts";

const served = handleToolCall(
  { venues: await loadVenues(), byVenueSku: new Map(), byVenueId: new Map(), ambiguousSkus: new Map(), allItems: [] },
  "menu",
  {},
);
const servedBytes = new TextEncoder().encode(served.content[0].text).length;
// Compact, because the served reply is compact: a pretty-printed comparison reports
// numbers no relay ever sees (see evidence/options-groups/served-menu-size.md).
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const venues = await loadVenues();
const lines: string[] = [];
for (const v of venues) {
  const catalogueOnly = { ...v, items: v.items.map((it) => ({ ...it, option_groups: [] })) };
  // The literal AC1 shape: this item's groups, each choice priced for this item.
  const perItem = {
    ...catalogueOnly,
    items: v.items.map((it) => {
      const key = priceKeyOf(it.price_level_used ?? "");
      return {
        ...it,
        option_groups: it.option_groups.map((g) => ({
          id: g.id,
          name: g.name,
          required: g.required,
          multi_select: g.multi_select,
          min_count: g.min_count,
          max_count: g.max_count,
          choices: g.choices.map((c) => ({
            id: c.id,
            name: c.name,
            available: c.available,
            price: priceForItem(c, key),
          })),
        })),
      };
    }),
  };
  lines.push(
    `${v.slug}: ${v.items.length} items, ${v.option_groups.length} catalogue groups | ` +
      `item+ids only ${bytes(catalogueOnly)}B | catalogue form ${bytes(v)}B | ` +
      `per-item form ${bytes(perItem)}B`,
  );
}

console.log(`catalogue form (exactly as served): ${servedBytes} B`);
lines.forEach((l) => console.log("  " + l));
console.log(
  "relay caps: strfry maxWebsocketPayloadSize 131072 B (frame) / maxEventSize 65536 B (event)",
);
