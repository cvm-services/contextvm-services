/**
 * Customer API for the facilitator-LNURLP flow (Option A).
 *
 * The customer service is deliberately boring and unprivileged: it prices the
 * basket, asks the root-side LNURLP server for an invoice, and proxies the order
 * status. It holds **no treasury/2fiat secret** and never pays anything.
 *
 *   POST /orders        -> create a LNURLP invoice for the customer price
 *   GET  /orders/:id    -> pending/paid/confirmed from the LNURLP ledger
 *   POST /orders/:id/check -> force one payment check (the customer button)
 *   GET  /menu          -> the server-priced menu
 *   POST /orders/:id/pay -> 409: the customer pays the BOLT11, not this service
 */
const PORT = Number(Deno.env.get("CVM_CUSTOMER_PORT") ?? "8793");
const HOST = Deno.env.get("CVM_CUSTOMER_HOST") ?? "127.0.0.1";
const MENU_FILE = Deno.env.get("CVM_MENU_FILE") ??
  new URL("../venues/three-buddies-berlin/menu.sats.fixture.json", import.meta.url).pathname;
const LNURLP_BASE = (Deno.env.get("CVM_LNURLP_BASE") ??
  "https://cvm-pwa.orangesync.tech").replace(/\/+$/, "");
const LNURLP_TOKEN = (Deno.env.get("CVM_LNURLP_TOKEN") ?? "").trim();
const MARGIN_PCT = Number(Deno.env.get("CVM_FACILITATOR_MARGIN_PCT") ?? "10");
const FACILITATOR_NAME = Deno.env.get("CVM_FACILITATOR_NAME") ?? "Facilitator";
const MAX_QTY = 20;

export interface MenuItem {
  id: string;
  name: string;
  sats: number;
  eur?: number;
  allergens?: string[];
}

export interface MenuVenue {
  slug: string;
  name: string;
  address?: Record<string, unknown> | null;
  location?: { lat: number; lon: number; attribution?: string } | null;
  items: MenuItem[];
}

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function readItems(raw: unknown, satsPerEur = 1000): MenuItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("menu has no items");
  return raw.map((value) => {
    const it = value as Partial<MenuItem> & {
      sku?: string;
      prices_by_order_method?: Record<string, number>;
    };
    const id = typeof it.id === "string" && it.id.trim() ? it.id : typeof it.sku === "string" ? it.sku : "";
    if (!id || typeof it.name !== "string") throw new Error("menu item needs id/name");
    let sats = Number(it.sats);
    if (!Number.isFinite(sats) || sats <= 0) {
      const prices = it.prices_by_order_method || {};
      const first = Object.values(prices).find((n) => Number.isFinite(Number(n)));
      sats = first === undefined ? 0 : Math.ceil(Number(first) * satsPerEur);
    }
    if (!Number.isFinite(sats) || sats <= 0) {
      throw new Error(`menu item ${id} needs a positive sats price`);
    }
    return {
      id, name: it.name, sats,
      eur: it.eur === undefined ? undefined : Number(it.eur),
      allergens: it.allergens,
    };
  });
}

export function readMenu(doc: unknown): MenuItem[] {
  const items = Array.isArray(doc) ? doc : (doc as { items?: unknown })?.items;
  return readItems(items);
}

/** Accept either the old single menu or the multi-venue menu served at /order. */
export function readVenues(doc: unknown): MenuVenue[] {
  const root = (doc && typeof doc === "object" ? doc : {}) as {
    venues?: unknown; items?: unknown; venue?: unknown;
    sats_per_eur?: number; name?: string; venue_slug?: string;
  };
  if (Array.isArray(root.venues) && root.venues.length) {
    const rate = Number(root.sats_per_eur) || 1000;
    return root.venues.map((value) => {
      const v = value as Record<string, unknown>;
      const slug = String(v.venue_slug || v.slug || "");
      const name = String(v.name || slug || "Venue");
      if (!slug) throw new Error("venue needs a slug");
      return {
        slug, name,
        address: (v.address as Record<string, unknown>) ?? null,
        location: (v.location as MenuVenue["location"]) ?? null,
        items: readItems(v.items, rate),
      };
    });
  }
  return [{
    slug: String(root.venue_slug || "three-buddies"),
    name: String(root.name || "Three Buddies"),
    address: null,
    location: null,
    items: readMenu(doc),
  }];
}

export function priceBasket(
  menu: MenuItem[],
  items: unknown,
  marginPct: number,
): { priced: Array<{ id: string; name: string; qty: number; sats: number }>; menuTotal: number; customerSats: number } {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "empty_basket", "the basket is empty");
  }
  const byId = new Map(menu.map((m) => [m.id, m]));
  const priced: Array<{ id: string; name: string; qty: number; sats: number }> = [];
  let menuTotal = 0;
  for (const raw of items) {
    const row = raw as { id?: unknown; qty?: unknown };
    const id = String(row?.id ?? "");
    const qty = Number(row?.qty);
    const item = byId.get(id);
    if (!item) throw new ApiError(400, "unknown_item", `unknown item: ${id}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new ApiError(400, "bad_quantity", `bad quantity for ${id}`);
    }
    const line = item.sats * qty;
    priced.push({ id, name: item.name, qty, sats: line });
    menuTotal += line;
  }
  const customerSats = Math.ceil(menuTotal * (1 + Math.max(0, marginPct) / 100));
  return { priced, menuTotal, customerSats };
}

async function lnurlp(
  base: string, token: string, path: string, init: RequestInit, fetchImpl: typeof fetch,
): Promise<any> {
  if (!token) {
    throw new ApiError(503, "lnurlp_token_missing", "CVM_LNURLP_TOKEN is not set");
  }
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/lnurlp/internal${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(502, "lnurlp_error",
      `${body?.error || body?.reason || "LNURLP error"} (HTTP ${res.status})`);
  }
  return body;
}

export function createHandler(opts: {
  menu?: MenuItem[];
  venues?: MenuVenue[];
  lnurlpBase?: string;
  lnurlpToken?: string;
  marginPct?: number;
  fetchImpl?: typeof fetch;
}) {
  const venues = opts.venues ?? [{
    slug: "three-buddies", name: "Three Buddies",
    address: null, location: null, items: opts.menu ?? [],
  }];
  if (!venues.length) throw new Error("customer menu has no venues");
  const menu = venues[0].items;
  const margin = opts.marginPct ?? MARGIN_PCT;
  const base = opts.lnurlpBase ?? LNURLP_BASE;
  const token = opts.lnurlpToken ?? LNURLP_TOKEN;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/menu") {
      return json(200, { venue: venues[0].name, items: venues[0].items });
    }
    if (req.method === "GET" && path === "/venues") {
      return json(200, { venues: venues.map((v) => ({
        venue_slug: v.slug, name: v.name, address: v.address,
        location: v.location, items: v.items,
      })) });
    }
    if (req.method === "GET" && path === "/health") {
      return json(200, {
        ok: true, service: "customer-lnurlp", menu_items: venues.reduce((n, v) => n + v.items.length, 0),
        lnurlp_base: base, margin_pct: margin,
        facilitator: FACILITATOR_NAME,
      });
    }

    if (req.method === "POST" && path === "/orders") {
      let body: unknown = {};
      try { body = await req.json(); } catch { /* handled below */ }
      const items = (body as { items?: unknown; venue_slug?: unknown })?.items;
      const slug = String((body as { venue_slug?: unknown })?.venue_slug ?? "");
      const venue = slug ? venues.find((v) => v.slug === slug) : venues[0];
      if (!venue) return json(400, { error: "unknown_venue", detail: `unknown venue: ${slug}` });
      let priced;
      try {
        priced = priceBasket(venue.items, items, margin);
      } catch (e) {
        if (e instanceof ApiError) return json(e.status, { error: e.code, detail: e.message });
        throw e;
      }
      const orderId = `o_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      let inv: any;
      try {
        inv = await lnurlp(base, token, "/orders", {
          method: "POST",
          body: JSON.stringify({
            order_id: orderId,
            sats: priced.customerSats,
            comment: orderId,
          }),
        }, fetchImpl);
      } catch (e) {
        const detail = String((e as Error)?.message ?? e);
        console.error(JSON.stringify({ fatal: "invoice_failed", order_id: orderId, detail }));
        return json(502, { error: "invoice_failed", detail });
      }
      if (!inv?.bolt11) {
        return json(502, { error: "invoice_failed", detail: "LNURLP returned no BOLT11" });
      }
      return json(201, {
        order_id: orderId,
        venue_slug: venue.slug,
        venue_name: venue.name,
        sats: priced.customerSats,
        bolt11: inv.bolt11,
        state: "invoiced",
        price_source: "facilitator_lnurl",
        estimate_sats: priced.menuTotal,
        items: priced.priced,
      });
    }

    const m = /^\/orders\/([A-Za-z0-9._:-]{1,64})$/.exec(path);
    if (m && req.method === "GET") {
      let row: any;
      try {
        row = await lnurlp(base, token, `/orders/${encodeURIComponent(m[1])}`, { method: "GET" }, fetchImpl);
      } catch (e) {
        return json(502, { error: "order_status_failed", detail: String((e as Error)?.message ?? e) });
      }
      const state = row.status === "paid" ? "paid"
        : row.status === "expired" ? "expired" : "invoiced";
      return json(200, {
        order_id: row.order_id,
        state,
        sats: row.sats,
        venue_ref: row.venue_ref ?? null,
        paid_at: row.paid_at ?? null,
        can_pay: false,
        must_not_repay: false,
      });
    }
    const check = /^\/orders\/([A-Za-z0-9._:-]{1,64})\/check$/.exec(path);
    if (check && req.method === "POST") {
      let row: any;
      try {
        row = await lnurlp(
          base, token,
          `/orders/${encodeURIComponent(check[1])}/claim`,
          { method: "POST" }, fetchImpl,
        );
      } catch (e) {
        return json(502, {
          error: "check_failed",
          detail: String((e as Error)?.message ?? e),
        });
      }
      const state = row.status === "paid" ? "paid"
        : row.status === "expired" ? "expired" : "invoiced";
      return json(200, {
        order_id: row.order_id,
        state,
        sats: row.sats,
        venue_ref: row.venue_ref ?? null,
        paid_at: row.paid_at ?? null,
        claimed: Boolean(row.claimed),
        can_pay: false,
        must_not_repay: false,
      });
    }
    const pay = /^\/orders\/([A-Za-z0-9._:-]{1,64})\/pay$/.exec(path);
    if (pay && req.method === "POST") {
      return json(409, {
        error: "customer_pays_invoice",
        detail: "Pay the BOLT11 from your Lightning wallet; this service never spends.",
      });
    }
    return json(404, { error: "not_found" });
  };
}

if (import.meta.main) {
  const menuDoc = JSON.parse(await Deno.readTextFile(MENU_FILE));
  const venues = readVenues(menuDoc);
  const handler = createHandler({ venues });
  console.error(JSON.stringify({
    listening: PORT, host: HOST, menu_items: venues.reduce((n, v) => n + v.items.length, 0),
    lnurlp_base: LNURLP_BASE, margin_pct: MARGIN_PCT,
    lnurlp_token_configured: Boolean(LNURLP_TOKEN),
  }));
  Deno.serve({ port: PORT, hostname: HOST }, handler);
}
