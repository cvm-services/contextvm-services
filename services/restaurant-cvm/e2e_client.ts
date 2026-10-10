// e2e_client.ts — a minimal CVM client that speaks the real ContextVM wire
// protocol against the venue server over a real Nostr relay.
//
// It does NOT use @contextvm/sdk (which the venue server also does not use);
// it hand-rolls the exact same wire shape the SDK's transport emits, so the
// test proves the server's transport interops with the documented protocol,
// not just with one SDK version:
//
//   1. Client generates an ephemeral key pair.
//   2. It subscribes to gift-wrap events (kind 1059/21059) addressed to its
//      own pubkey (`#p` = clientPk), with since=now so it only sees replies
//      to this session.
//   3. For each request it: signs a kind-25910 event (the "rumor", content =
//      the JSON-RPC message), gift-wraps that signed event in a fresh kind-1059
//      envelope (NIP-44 v2, conversation key = wrap key + server pubkey), and
//      publishes it. The envelope's `p` tag = server pubkey.
//   4. On receiving a gift wrap addressed to it, it decrypts with the client
//      secret + the gift-wrap's ephemeral pubkey, recovers the signed inner
//      25910 event, and reads its content as the JSON-RPC response.
//
// This is byte-for-byte the shape @contextvm/sdk's base-nostr-transport emits
// (core/constants.js: CTXVM_MESSAGES_KIND=25910, GIFT_WRAP_KIND=1059,
//  EPHEMERAL_GIFT_WRAP_KIND=21059; core/encryption.js: encryptMessage wraps
//  JSON.stringify(signedInnerEvent) with nip44.v2 and a fresh wrap key).
//
// Usage:
//   deno run --allow-net --allow-read --allow-env \
//     services/restaurant-cvm/e2e_client.ts \
//     --server <server-pubkey-hex> --relay wss://... [--relay wss://...] \
//     [--venue <venue-slug>] [--json] [--timeout-ms 30000]
//
// --venue scopes the assertions to a single announced identity: the client
// expects ONLY that venue's menu (slug set + item count) and orders against it.
// Omit --venue to assert every venue this checkout declares (an unscoped
// instance serves the whole catalogue on one identity). The per-venue
// expectations are DERIVED from the venue records, so an onboarded venue needs
// no edit here.
//
// Prints the raw request and response events to stdout. Exit 0 if
// tools/list AND tools/call both return a well-formed result; non-zero
// otherwise, with the failure point named.

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "npm:nostr-tools";
import { Relay } from "npm:nostr-tools/relay";
import { loadVenues, type Venue } from "./server.ts";

const CTXVM_MESSAGES_KIND = 25910;
const GIFT_WRAP_KIND = 1059;
const EPHEMERAL_GIFT_WRAP_KIND = 21059;

// Per-venue expectations are DERIVED from the venue records: onboarding a venue
// must not require editing this client. The item count is the record's own menu
// length, and the basket is two lines taken from the venue's own menu (see
// basketFor). Absent --venue, the client asserts every venue this checkout
// declares (the unscoped instance serves the whole catalogue on one identity).
export interface VenueOrderArg {
  venue_slug: string;
  items: Array<Record<string, unknown>>;
  fulfilment: string;
  when: string;
  notes: string;
  ship?: Record<string, unknown>;
}

export interface VenueExpectation {
  items: number;
  order: VenueOrderArg;
}

/**
 * A basket the venue can actually price: items that are available and carry no
 * option groups (the client cannot invent option choices), identified by sku
 * where the sku is unique in the menu and by the venue item id otherwise (pizza
 * collides on sku 36). Two lines, qty 2 + 1, so the round-trip still exercises
 * quantity arithmetic.
 */
function basketFor(venue: Venue): Array<Record<string, unknown>> {
  const skuCount = new Map<string, number>();
  for (const item of venue.items) {
    skuCount.set(item.sku, (skuCount.get(item.sku) ?? 0) + 1);
  }
  const lines: Array<Record<string, unknown>> = [];
  for (const item of venue.items) {
    if (lines.length === 2) break;
    if (!item.available || item.option_group_ids.length > 0) continue;
    const bySku = Boolean(item.sku) && skuCount.get(item.sku) === 1;
    lines.push({
      ...(bySku ? { sku: item.sku } : { id: item.id }),
      qty: lines.length === 0 ? 2 : 1,
    });
  }
  return lines;
}

/**
 * The fulfilment the venue itself declares. 'delivery' is avoided: the server
 * rightly requires a ship.address the client has no way to know.
 */
function fulfilmentFor(venue: Venue): string {
  const methods = venue.order_methods ?? [];
  if (methods.includes("pickup")) return "pickup";
  if (methods.includes("dine_in")) return "dine_in";
  return "pickup";
}

/** Derive one expectation per served venue, from the venue records alone. */
export async function deriveVenueCfg(
  filter?: string[],
): Promise<Record<string, VenueExpectation>> {
  const cfg: Record<string, VenueExpectation> = {};
  for (const venue of await loadVenues(filter)) {
    cfg[venue.slug] = {
      items: venue.items.length,
      order: {
        venue_slug: venue.slug,
        items: basketFor(venue),
        fulfilment: fulfilmentFor(venue),
        when: "asap",
        notes: `e2e relay round-trip (${venue.slug})`,
      },
    };
  }
  return cfg;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

// Wrap a signed inner event in a NIP-59 gift wrap addressed to `recipient`.
function giftWrap(
  signedInner: NostrEvent,
  recipient: string,
  wrapKind: number = GIFT_WRAP_KIND,
): NostrEvent {
  const wrapSk = generateSecretKey();
  const wrapPk = getPublicKey(wrapSk);
  const convKey = nip44.v2.utils.getConversationKey(wrapSk, recipient);
  const encrypted = nip44.v2.encrypt(JSON.stringify(signedInner), convKey);
  const tmpl = {
    kind: wrapKind,
    content: encrypted,
    tags: [["p", recipient]],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: wrapPk,
  };
  return finalizeEvent(tmpl, wrapSk) as unknown as NostrEvent;
}

// Unwrap a gift wrap addressed to `clientSk`'s owner.
function giftUnwrap(
  event: NostrEvent,
  clientSk: Uint8Array,
): NostrEvent | null {
  if (event.kind !== GIFT_WRAP_KIND && event.kind !== EPHEMERAL_GIFT_WRAP_KIND) {
    return null;
  }
  const convKey = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
  const decrypted = nip44.v2.decrypt(event.content, convKey);
  return JSON.parse(decrypted) as NostrEvent;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function main() {
  const flags = parse(Deno.args, {
    string: ["server", "relay", "venue"],
    boolean: ["json"],
    // Without collect, a repeated --relay OVERWRITES: passing the announced set
    // (relay2 + primal) silently used only the last one. The announced relays
    // are the point of the test, so collect them.
    collect: ["relay"],
    alias: {},
  });

  const serverPk = flags.server;
  if (!serverPk || !/^[0-9a-f]{64}$/.test(serverPk)) {
    console.error("--server <64-hex pubkey> is required");
    Deno.exit(2);
  }
  const venueSlug = flags.venue ? String(flags.venue) : null;
  // Derived from the venue records themselves — never a hard-coded table, so
  // onboarding a venue does not require editing this client.
  const venueCfg = await deriveVenueCfg();
  const declaredSlugs = Object.keys(venueCfg).sort();
  if (venueSlug && !venueCfg[venueSlug]) {
    console.error(`--venue ${venueSlug} is not a known venue (${declaredSlugs.join(", ")})`);
    Deno.exit(2);
  }
  const relays = (Array.isArray(flags.relay) ? flags.relay : flags.relay ? [flags.relay] : []);
  if (relays.length === 0) {
    console.error("--relay wss://... is required (repeat for multiple)");
    Deno.exit(2);
  }
  const timeoutMs = Number(Deno.env.get("E2E_TIMEOUT_MS") ?? 30000);
  const jsonOut = flags.json;

  // Ephemeral client identity — never persisted, never reused.
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);

  const log = (msg: string) => {
    if (!jsonOut) console.error(msg);
  };
  log(`[e2e] client pubkey: ${clientPk}`);
  log(`[e2e] server pubkey: ${serverPk}`);
  log(`[e2e] relays: ${relays.join(", ")}`);

  // Connect to all relays.
  const connected: { url: string; relay: Relay }[] = [];
  for (const url of relays) {
    try {
      const relay = await Promise.race([
        Relay.connect(url),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("connect timeout 15s")), 15000)
        ),
      ]);
      connected.push({ url, relay });
      log(`[e2e] connected to ${url}`);
    } catch (e) {
      console.error(`[e2e] FAILED to connect ${url}: ${(e as Error).message}`);
      Deno.exit(1);
    }
  }
  if (connected.length === 0) {
    console.error("[e2e] no relay connected");
    Deno.exit(1);
  }

  const since = Math.floor(Date.now() / 1000);
  const transcript: Record<string, unknown>[] = [];

  // Pending request map: id -> { resolve, timer }
  const pending = new Map<
    string | number,
    { resolve: (ev: NostrEvent) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // Subscribe to gift wraps addressed to the client pubkey.
  for (const { url, relay } of connected) {
    relay.subscribe(
      [{ kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND], "#p": [clientPk], since }],
      {
        onevent: (event: NostrEvent) => {
          try {
            const inner = giftUnwrap(event, clientSk);
            if (!inner) return;
            let msg: { id?: string | number };
            try {
              msg = JSON.parse(inner.content);
            } catch {
              return;
            }
            const id = msg.id;
            if (id === undefined || id === null) return;
            const p = pending.get(id);
            if (p) {
              clearTimeout(p.timer);
              pending.delete(id);
              p.resolve(inner);
            }
          } catch (e) {
            log(`[e2e] unwrap error from ${url}: ${(e as Error).message}`);
          }
        },
        oneose: () => log(`[e2e] EOSE from ${url}`),
      },
    );
  }

  // Send a request and await the unwrapped signed inner response event.
  async function request(
    method: string,
    params: Record<string, unknown> | undefined,
    id: string | number,
  ): Promise<NostrEvent | null> {
    const mcpMsg = { jsonrpc: "2.0", id, method, params };
    const innerUnsigned = {
      kind: CTXVM_MESSAGES_KIND,
      pubkey: clientPk,
      tags: [["p", String(serverPk)]],
      content: JSON.stringify(mcpMsg),
      created_at: Math.floor(Date.now() / 1000),
    };
    const signedInner = finalizeEvent(innerUnsigned, clientSk) as unknown as NostrEvent;
    const wrap = giftWrap(signedInner, String(serverPk), GIFT_WRAP_KIND);

    log(`[e2e] -> ${method} (id=${id}) inner_event_id=${signedInner.id}`);

    // Publish to all relays; collect OK verdicts.
    const oks: Record<string, boolean | string> = {};
    await Promise.all(connected.map(async ({ url, relay }) => {
      try {
        await relay.publish(wrap);
        oks[url] = true;
      } catch (e) {
        oks[url] = (e as Error).message;
      }
    }));
    log(`[e2e]    published gift_wrap ${wrap.id} to: ${JSON.stringify(oks)}`);

    transcript.push({
      phase: "request",
      method,
      id,
      inner_event: signedInner,
      gift_wrap_event_id: wrap.id,
      gift_wrap_kind: wrap.kind,
      publish_ok: oks,
    });

    return new Promise<NostrEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        log(`[e2e] TIMEOUT awaiting response to ${method} (id=${id}) after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve: (ev) => resolve(ev), timer });
    });
  }

  // ---- The actual end-to-end run ----
  let exitCode = 0;
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // 1. initialize
  const initResp = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "venue-e2e-client", version: "1.0.0" },
  }, 0);
  if (!initResp) {
    checks.push({ name: "initialize", ok: false, detail: "no response (timeout)" });
  } else {
    const m = JSON.parse(initResp.content);
    transcript.push({ phase: "response", method: "initialize", id: 0, inner_event: initResp, mcp: m });
    const name = m?.result?.serverInfo?.name;
    checks.push({
      name: "initialize",
      ok: !!name && /venue/i.test(String(name)),
      detail: `serverInfo.name=${name}`,
    });
    log(`[e2e] <- initialize: serverInfo.name=${name}`);
  }

  // 2. tools/list
  const listResp = await request("tools/list", {}, 1);
  if (!listResp) {
    checks.push({ name: "tools/list", ok: false, detail: "no response (timeout)" });
  } else {
    const m = JSON.parse(listResp.content);
    transcript.push({ phase: "response", method: "tools/list", id: 1, inner_event: listResp, mcp: m });
    const tools = m?.result?.tools;
    const names = Array.isArray(tools) ? tools.map((t: { name: string }) => t.name).sort() : null;
    checks.push({
      name: "tools/list",
      ok: !!names && JSON.stringify(names) === JSON.stringify(["menu", "order"]),
      detail: `tools=${JSON.stringify(names)}`,
    });
    log(`[e2e] <- tools/list: tools=${JSON.stringify(names)}`);
  }

  // 3. tools/call menu (the venue-scoped catalogue, or the full one)
  const menuResp = await request("tools/call", { name: "menu", arguments: {} }, 2);
  if (!menuResp) {
    checks.push({ name: "tools/call:menu", ok: false, detail: "no response (timeout)" });
  } else {
    const m = JSON.parse(menuResp.content);
    transcript.push({ phase: "response", method: "tools/call", id: 2, tool: "menu", inner_event: menuResp, mcp: m });
    const payload = JSON.parse(m?.result?.content?.[0]?.text ?? "{}");
    const total = payload?.total_items;
    const venueSlugs = Array.isArray(payload?.venues)
      ? payload.venues.map((v: { venue_slug: string }) => v.venue_slug)
      : [];
    // Venue-scoped: exactly one venue, the requested one, with its item count.
    // Unscoped (default): every venue this checkout declares, on one identity.
    const expectSlugs = venueSlug ? [venueSlug] : declaredSlugs;
    const expectTotal = expectSlugs.reduce((sum, slug) => sum + (venueCfg[slug]?.items ?? 0), 0);
    const slugsMatch = JSON.stringify([...venueSlugs].sort()) === JSON.stringify([...expectSlugs].sort());
    checks.push({
      name: "tools/call:menu",
      ok: total === expectTotal && slugsMatch,
      detail: `total_items=${total} venues=${JSON.stringify(venueSlugs)} expected=${JSON.stringify(expectSlugs)}/${expectTotal}`,
    });
    log(`[e2e] <- tools/call menu: total_items=${total} venues=${JSON.stringify(venueSlugs)}`);
  }

  // 4. tools/call order (a real basket — pickup, no address needed)
  // Unscoped, the basket still names ONE venue: the first this checkout declares.
  const orderArgs = venueCfg[venueSlug ?? declaredSlugs[0]].order;
  const orderResp = await request("tools/call", { name: "order", arguments: orderArgs }, 3);
  if (!orderResp) {
    checks.push({ name: "tools/call:order", ok: false, detail: "no response (timeout)" });
  } else {
    const m = JSON.parse(orderResp.content);
    transcript.push({ phase: "response", method: "tools/call", id: 3, tool: "order", inner_event: orderResp, mcp: m });
    const payload = JSON.parse(m?.result?.content?.[0]?.text ?? "{}");
    const expectedLines = (orderArgs.items as unknown[]).length;
    const okOrder = payload?.status === "basket" &&
      Array.isArray(payload?.lines) && payload.lines.length === expectedLines &&
      typeof payload?.total === "number" &&
      !!payload?.venue?.deep_link &&
      payload?.venue?.slug === orderArgs.venue_slug;
    checks.push({
      name: "tools/call:order",
      ok: okOrder,
      detail: `status=${payload?.status} lines=${payload?.lines?.length} total=${payload?.total} venue=${payload?.venue?.slug} deep_link=${payload?.venue?.deep_link}`,
    });
    log(`[e2e] <- tools/call order: status=${payload?.status} total=${payload?.total}`);
  }

  // Emit the full raw transcript.
  console.log(JSON.stringify({
    client_pubkey: clientPk,
    server_pubkey: serverPk,
    venue: venueSlug,
    relays,
    started_at: since,
    checks,
    all_passed: checks.every((c) => c.ok),
    transcript,
  }, null, 2));

  for (const c of checks) {
    if (!c.ok) exitCode = 1;
  }
  for (const { relay } of connected) {
    try { relay.close(); } catch { /* ignore */ }
  }
  Deno.exit(exitCode);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[e2e] fatal:", e);
    Deno.exit(1);
  });
}