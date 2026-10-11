/**
 * menu_frame_size.ts — the size a relay actually sees for the `menu` reply.
 *
 * The reply is not the menu JSON: it is an inner kind-25910 event whose content is
 * the MCP response (which itself carries the menu JSON as a string), NIP-44
 * encrypted into a kind-1059 gift wrap. Every step adds size (JSON-in-JSON escaping,
 * then base64 over the ciphertext), so a payload check on the menu JSON alone
 * understates what a relay enforces.
 *
 * Run: deno run --allow-read tools/menu_frame_size.ts
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "npm:nostr-tools";
import { handleToolCall, loadVenues, type Venue } from "../services/restaurant-cvm/server.ts";
import { groupsForItem, priceForItem, priceKeyOf } from "./venue_option_groups.ts";

function giftWrapSize(payload: unknown): { event: number; frame: number; inner: number; enc: number } {
  const serverSk = generateSecretKey();
  const clientPk = getPublicKey(generateSecretKey());
  const inner = finalizeEvent(
    {
      kind: 25910,
      content: JSON.stringify(payload),
      tags: [["p", clientPk]],
      created_at: Math.floor(Date.now() / 1000),
    },
    serverSk,
  );
  const convKey = nip44.v2.utils.getConversationKey(serverSk, clientPk);
  const encrypted = nip44.v2.encrypt(JSON.stringify(inner), convKey);
  const wrap = finalizeEvent(
    { kind: 1059, content: encrypted, tags: [["p", clientPk]], created_at: inner.created_at },
    serverSk,
  );
  const enc = new TextEncoder();
  return {
    event: enc.encode(JSON.stringify(wrap)).length,
    frame: enc.encode(JSON.stringify(["EVENT", wrap])).length,
    inner: enc.encode(JSON.stringify(inner)).length,
    enc: enc.encode(encrypted).length,
  };
}

function mcpReply(text: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  };
}

const venues = await loadVenues();
const index = {
  venues,
  byVenueSku: new Map(),
  byVenueId: new Map(),
  ambiguousSkus: new Map(),
  allItems: [],
} as unknown as Parameters<typeof handleToolCall>[0];

const asServed = handleToolCall(index, "menu", {}).content[0].text;
const pizzaOnly = handleToolCall(index, "menu", { venue_slug: "pizza-e-pasta-ruedesheimerplatz" })
  .content[0].text;
const doppeltOnly = handleToolCall(index, "menu", { venue_slug: "doppelt-kaese-berlin" })
  .content[0].text;

// The literal PLAN-0006 AC1 shape, for comparison: every item carrying its own
// resolved copy of every group it offers.
const perItem = JSON.stringify({
  venues: (venues as Venue[]).map((v) => ({
    ...v,
    items: v.items.map((it) => ({
      ...it,
      option_groups: groupsForItem(it.option_group_ids, v.option_groups).map((g) => ({
        ...g,
        choices: g.choices.map((c) => ({
          id: c.id,
          name: c.name,
          available: c.available,
          price: priceForItem(c, priceKeyOf(it.price_level_used ?? "")),
        })),
      })),
    })),
  })),
}, null, 2);

const rows: [string, string][] = [
  ["catalogue form, all venues (as served)", asServed],
  ["catalogue form, pizza only (venue_slug filter)", pizzaOnly],
  ["catalogue form, doppelt only (venue_slug filter)", doppeltOnly],
  ["per-item form, all venues (rejected)", perItem],
];
console.log("payload → gift-wrapped event / frame, bytes");
for (const [label, text] of rows) {
  const { event, frame, inner, enc } = giftWrapSize(mcpReply(text));
  console.log(
    `  ${label}: payload ${new TextEncoder().encode(text).length} → inner ${inner} → encrypted ${enc} → event ${event} / frame ${frame}`,
  );
}
console.log("caps: strfry maxEventSize 65536 (event), maxWebsocketPayloadSize 131072 (frame)");
