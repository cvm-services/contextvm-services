// Venue CVM server -- Stage 1 (orderable venues, no settlement).
//
// Exposes two MCP tools over the ContextVM protocol:
//   - menu  -> returns the full venue catalogue (188 items across two venues).
//   - order -> validates a basket, computes a per-method total, and returns
//              a hand-off payload: the basket, the venue's own rail, and the
//              deep-link. No payment is taken; no order is placed.
//
// Scope is deliberately limited to Stage 1 of PLAN-0005:
//   - real menu sourced from venues/*/venue.json
//   - order arguments matching the service-inputs register
//   - loud failures for unknown skus and missing delivery addresses
//   - no settlement, no Lightning, no Cashu, no invoice generation.

import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "npm:nostr-tools";
import { Relay } from "npm:nostr-tools/relay";

// =====================================================================
// DATA TYPES
// =====================================================================

export interface MenuItem {
  venue_slug: string;
  sku: string;
  name: string;
  prices_by_order_method: Record<string, number>;
  available: boolean;
  allergens: string[] | null;
  option_group_ids: string[];
}

export interface Venue {
  slug: string;
  name: string;
  currency: string;
  deep_link: string;
  rail: string | null;
  order_methods: string[];
  items: MenuItem[];
}

interface OrderLine {
  sku: string;
  qty: number;
  options?: Record<string, unknown>;
}

export interface OrderInput {
  items: OrderLine[];
  fulfilment: "pickup" | "delivery" | "dine_in";
  when: string;
  notes?: string;
  ship?: {
    address?: {
      street?: string;
      city?: string;
      postal_code?: string;
      country?: string;
      [k: string]: unknown;
    };
    recipient_name?: string;
    notes?: string;
    [k: string]: unknown;
  };
  contact?: {
    name?: string;
    phone?: string;
    email?: string;
    [k: string]: unknown;
  };
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// =====================================================================
// MENU LOADING
// =====================================================================

const VENUE_PATHS: [string, string][] = [
  ["doppelt-kaese-berlin", "../../venues/doppelt-kaese-berlin/venue.json"],
  ["pizza-e-pasta-ruedesheimerplatz", "../../venues/pizza-e-pasta-ruedesheimerplatz/venue.json"],
];

function numeric(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export async function loadVenues(): Promise<Venue[]> {
  const venues: Venue[] = [];
  for (const [slug, relPath] of VENUE_PATHS) {
    const url = new URL(relPath, import.meta.url);
    const raw = JSON.parse(await Deno.readTextFile(url));
    const v = raw.venue ?? {};
    const menu = raw.menu ?? {};
    const currency = v.currency ?? menu.currency ?? "EUR";
    const deepLink = v.ordering?.primary_url ?? v.website ?? null;
    if (!deepLink) {
      throw new Error(`venue '${slug}' has no ordering.primary_url or website`);
    }

    const methods = fulfilmentMethods(v.order_methods ?? []);
    const capturedMethod = String(menu.service_method ?? "");

    const items: MenuItem[] = (menu.items ?? []).map((it: Record<string, unknown>) => {
      let prices: Record<string, number>;
      if (
        it.prices_by_order_method && typeof it.prices_by_order_method === "object" &&
        !Array.isArray(it.prices_by_order_method)
      ) {
        prices = {};
        for (const [m, p] of Object.entries(it.prices_by_order_method as Record<string, unknown>)) {
          if (numeric(p)) prices[m] = p;
        }
      } else {
        prices = {};
        if (numeric(it.price) && capturedMethod) prices[capturedMethod] = it.price as number;
      }

      return {
        venue_slug: slug,
        sku: String(it.sku ?? ""),
        name: String(it.name ?? ""),
        prices_by_order_method: prices,
        available: it.available === true,
        allergens: Array.isArray(it.allergens) ? it.allergens as string[] : null,
        option_group_ids: Array.isArray(it.option_group_ids)
          ? (it.option_group_ids as unknown[]).map(String)
          : [],
      };
    });

    venues.push({
      slug,
      name: v.name ?? slug,
      currency,
      deep_link: deepLink,
      rail: v.settlement?.rail ?? null,
      order_methods: methods,
      items,
    });
  }
  return venues;
}

function fulfilmentMethods(methods: unknown[]): string[] {
  const out: string[] = [];
  for (const m of methods) {
    const s = String(m);
    if ((s === "pickup" || s === "delivery" || s === "dine_in") && !out.includes(s)) out.push(s);
  }
  return out;
}

// =====================================================================
// INDEXES (built once per process)
// =====================================================================

export type VenueIndex = {
  venues: Venue[];
  byVenueSku: Map<string, Map<string, MenuItem>>;
  allItems: MenuItem[];
};

export async function buildIndex(): Promise<VenueIndex> {
  const venues = await loadVenues();
  const byVenueSku = new Map<string, Map<string, MenuItem>>();
  const allItems: MenuItem[] = [];
  for (const v of venues) {
    const map = new Map<string, MenuItem>();
    for (const it of v.items) {
      // Pizza venue has duplicate skus (e.g. 110, 36, 44) for distinct items.
      // The menu keeps all of them; the first occurrence is what an order by
      // sku resolves to. This matches the venue's own data shape.
      if (!map.has(it.sku)) map.set(it.sku, it);
      allItems.push(it);
    }
    byVenueSku.set(v.slug, map);
  }
  return { venues, byVenueSku, allItems };
}

// =====================================================================
// TOOL DEFINITIONS
// =====================================================================

export const TOOL_DEFS: McpToolDef[] = [
  {
    name: "menu",
    description:
      "Return the full menu for all announced venues. Each item carries sku, name, prices_by_order_method, available, and allergens.",
    inputSchema: {
      type: "object",
      properties: {
        venue_slug: {
          type: "string",
          description: "Optional: filter to a single venue slug. Omit to receive all venues.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "order",
    description:
      "Build a basket for the venue's own ordering rail. Checkout and payment happen on the venue's own page; this tool does not place or settle the order.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Basket lines: {sku, qty, options?}",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              qty: { type: "integer", minimum: 1 },
              options: { type: "object" },
            },
            required: ["sku", "qty"],
            additionalProperties: false,
          },
        },
        fulfilment: {
          type: "string",
          enum: ["pickup", "delivery", "dine_in"],
          description: "How the order will be fulfilled.",
        },
        when: {
          type: "string",
          description: "Requested fulfilment time (ISO 8601 or 'asap').",
        },
        notes: {
          type: "string",
          description: "Free text for the kitchen/handler.",
        },
        ship: {
          type: "object",
          description: "Required only when fulfilment == 'delivery'.",
          properties: {
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
                postal_code: { type: "string" },
                country: { type: "string" },
              },
            },
            recipient_name: { type: "string" },
            notes: { type: "string" },
          },
        },
        venue_slug: {
          type: "string",
          description: "The venue to order from.",
        },
        contact: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
          },
        },
      },
      required: ["venue_slug", "items", "fulfilment", "when"],
      additionalProperties: false,
    },
  },
];

// =====================================================================
// TOOL IMPLEMENTATIONS
// =====================================================================

function toolError(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function toolOk(payload: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function priceForMethod(
  item: MenuItem,
  method: string,
): { price: number; method_used: string; note: string | null } {
  if (item.prices_by_order_method[method] !== undefined) {
    return { price: item.prices_by_order_method[method], method_used: method, note: null };
  }
  const methods = Object.keys(item.prices_by_order_method);
  if (methods.length === 1) {
    const fallback = methods[0];
    return {
      price: item.prices_by_order_method[fallback],
      method_used: fallback,
      note: `${method} price not published; using ${fallback} price`,
    };
  }
  return {
    price: item.prices_by_order_method[methods[0]] ?? 0,
    method_used: methods[0] ?? "unknown",
    note: `${method} price not published; using fallback`,
  };
}

function handleMenu(index: VenueIndex, args: Record<string, unknown>): McpToolResult {
  const filterSlug = args.venue_slug ? String(args.venue_slug) : null;
  const venues = filterSlug ? index.venues.filter((v) => v.slug === filterSlug) : index.venues;
  if (filterSlug && venues.length === 0) {
    return toolError(`unknown venue_slug: ${filterSlug}`);
  }

  const out = venues.map((v) => ({
    venue_slug: v.slug,
    name: v.name,
    currency: v.currency,
    item_count: v.items.length,
    items: v.items.map((it) => ({
      sku: it.sku,
      name: it.name,
      prices_by_order_method: it.prices_by_order_method,
      available: it.available,
      allergens: it.allergens,
      option_group_ids: it.option_group_ids,
    })),
  }));
  return toolOk({
    total_items: venues.reduce((n, v) => n + v.items.length, 0),
    venues: out,
  });
}

function handleOrder(index: VenueIndex, args: Record<string, unknown>): McpToolResult {
  const itemsRaw = args.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    return toolError("order.items must be a non-empty array");
  }
  const fulfilment = String(args.fulfilment ?? "");
  if (!["pickup", "delivery", "dine_in"].includes(fulfilment)) {
    return toolError(`order.fulfilment must be pickup|delivery|dine_in, got '${fulfilment}'`);
  }
  const when = String(args.when ?? "");
  if (!when) return toolError("order.when is required");

  // Conditional requirement: ship.address is required iff fulfilment == delivery.
  if (fulfilment === "delivery") {
    const addr = (args.ship as Record<string, unknown> | undefined)?.address;
    if (!addr || typeof addr !== "object" || Array.isArray(addr)) {
      return toolError("ship.address is required for delivery orders");
    }
  }

  // Resolve venue from the explicit venue_slug argument.
  const venueSlug = String(args.venue_slug ?? "");
  const venue = index.venues.find((v) => v.slug === venueSlug);
  if (!venue) {
    return toolError(`unknown venue_slug: ${venueSlug}`);
  }
  const bySku = index.byVenueSku.get(venueSlug);
  if (!bySku) {
    return toolError(`internal error: no sku index for venue ${venueSlug}`);
  }

  const lines: {
    sku: string;
    name: string;
    qty: number;
    unit_price: number;
    method_used: string;
    line_total: number;
    price_note: string | null;
    available: boolean;
    options?: Record<string, unknown>;
  }[] = [];
  let total = 0;

  for (const raw of itemsRaw) {
    const line = raw as Record<string, unknown>;
    const sku = String(line.sku ?? "");
    const item = bySku.get(sku);
    if (!item) {
      return toolError(`unknown sku: ${sku}`);
    }
    const qty = Number(line.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1) {
      return toolError(`invalid qty for sku ${sku}: ${qty}`);
    }
    const { price, method_used, note } = priceForMethod(item, fulfilment);
    const lineTotal = Math.round(price * qty * 100) / 100;
    lines.push({
      sku,
      name: item.name,
      qty,
      unit_price: price,
      method_used,
      line_total: lineTotal,
      price_note: note,
      available: item.available,
      options: typeof line.options === "object" && !Array.isArray(line.options)
        ? line.options as Record<string, unknown>
        : undefined,
    });
    total += lineTotal;
  }

  total = Math.round(total * 100) / 100;

  return toolOk({
    status: "basket",
    note:
      "This is a prepared basket, not a placed order. Checkout and payment happen on the venue's own page.",
    venue: {
      slug: venue.slug,
      name: venue.name,
      currency: venue.currency,
      rail: venue.rail,
      deep_link: venue.deep_link,
    },
    fulfilment,
    when,
    notes: args.notes ? String(args.notes) : undefined,
    ship: args.ship,
    contact: args.contact,
    lines,
    total,
  });
}

export function handleToolCall(
  index: VenueIndex,
  name: string,
  args: Record<string, unknown> = {},
): McpToolResult {
  if (name === "menu") return handleMenu(index, args);
  if (name === "order") return handleOrder(index, args);
  return toolError(`unknown tool: ${name}`);
}

// =====================================================================
// MCP JSON-RPC HANDLER (relay-agnostic, usable from tests)
// =====================================================================

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function handleMcpMessage(
  index: VenueIndex,
  message: McpRequest,
): Promise<McpResponse | null> {
  const { method, id } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "contextvm-venue-server",
          version: "1.0.0",
        },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOL_DEFS },
    };
  }

  if (method === "tools/call") {
    const toolName = String(message.params?.name ?? "");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    const result = handleToolCall(index, toolName, args);
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  };
}

// =====================================================================
// LIVE NOSTR SERVER (direct nostr-tools implementation, Deno-compatible)
// =====================================================================

export interface ServeOptions {
  serverHex: string;
  relays?: string[];
  log?: (msg: string) => void;
}

export async function serve(options: ServeOptions): Promise<() => void> {
  const index = await buildIndex();
  const match = options.serverHex.match(/.{2}/g);
  if (!match) throw new Error("SERVER_HEX is not valid hex");
  const serverSk = new Uint8Array(match.map((b) => parseInt(b, 16)));
  const serverPk = getPublicKey(serverSk);
  const log = options.log ?? console.log;
  const relays = options.relays ?? ["wss://nostr.mom", "wss://relay.primal.net"];

  log(`[venue-cvm] starting; pubkey ${serverPk}`);
  log(
    `[venue-cvm] menu loaded: ${index.allItems.length} items across ${index.venues.length} venues`,
  );

  const connectedRelays: Relay[] = [];

  async function sendResponse(mcpMessage: McpResponse, clientPubkey: string) {
    const innerEvent = {
      pubkey: serverPk,
      kind: 25910,
      tags: [["p", clientPubkey]],
      content: JSON.stringify(mcpMessage),
      created_at: Math.floor(Date.now() / 1000),
    };
    const signedEvent = finalizeEvent(innerEvent, serverSk);

    const wrapSk = generateSecretKey();
    const wrapPk = getPublicKey(wrapSk);
    const convKey = nip44.v2.utils.getConversationKey(wrapSk, clientPubkey);
    const encrypted = nip44.v2.encrypt(JSON.stringify(signedEvent), convKey);

    const giftWrap = {
      kind: 1059,
      content: encrypted,
      tags: [["p", clientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: wrapPk,
    };
    const signedGiftWrap = finalizeEvent(giftWrap, wrapSk);

    for (const relay of connectedRelays) {
      try {
        await relay.publish(signedGiftWrap);
      } catch (e) {
        log(`[venue-cvm] publish warning: ${(e as Error).message}`);
      }
    }
  }

  for (const url of relays) {
    try {
      const relay = await Promise.race([
        Relay.connect(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("connection timeout (10s)")), 10000)
        ),
      ]);
      log(`[venue-cvm] connected to ${url}`);

      relay.subscribe(
        [{ kinds: [1059, 21059], limit: 0 }],
        {
          onevent: async (event) => {
            try {
              const pTag = event.tags?.find((t: string[]) => t[0] === "p");
              if (!pTag || pTag[1] !== serverPk) return;

              const convKey = nip44.v2.utils.getConversationKey(serverSk, event.pubkey);
              const decrypted = nip44.v2.decrypt(event.content, convKey);
              const innerEvent = JSON.parse(decrypted);
              const mcpMessage = JSON.parse(innerEvent.content);
              const clientPubkey = innerEvent.pubkey || event.pubkey;

              const response = await handleMcpMessage(index, mcpMessage);
              if (response) {
                await sendResponse(response, clientPubkey);
              }
            } catch (e) {
              log(`[venue-cvm] handler error: ${(e as Error).message}`);
            }
          },
          oneose: () => log(`[venue-cvm] EOSE from ${url}`),
        },
      );
      connectedRelays.push(relay);
    } catch (e) {
      log(`[venue-cvm] failed to connect ${url}: ${(e as Error).message}`);
    }
  }

  log(`[venue-cvm] live; ${connectedRelays.length}/${relays.length} relays connected`);

  return () => {
    for (const relay of connectedRelays) {
      try {
        relay.close();
      } catch (_) {
        // ignore
      }
    }
  };
}

// CLI entry point (only runs when executed directly)
if (import.meta.main) {
  const hex = Deno.env.get("SERVER_HEX");
  if (!hex) {
    console.error("SERVER_HEX env var is required");
    Deno.exit(1);
  }
  serve({ serverHex: hex }).catch((err) => {
    console.error("[venue-cvm] fatal:", err);
    Deno.exit(1);
  });
}
