/**
 * Customer HTTP surface: menu, basket, invoice, payment state.
 *
 * Two rules decide everything here:
 *
 *   1. THE SERVER PRICES THE BASKET. A client that sends a price is ignored; the
 *      total comes from the menu. Any other design lets a phone buy a pizza for
 *      one sat.
 *   2. THE UI LEARNS THE TRUTH FROM THE RAIL. `state` is whatever settlement
 *      says - never an optimistic guess. `outcome_unknown` is surfaced as its own
 *      state precisely so the customer does not pay twice while the first payment
 *      is unresolved.
 */

import { Settlement, SettlementError } from "./settlement.ts";

export interface MenuItem {
  id: string;
  name: string;
  /** Server-side price. The client never supplies this. */
  sats: number;
  /**
   * The venue's own EUR price, when known. Needed because the fiat rail buys card
   * value in USD and 2fiat converts to sats itself - the sats figure is derived,
   * the EUR figure is the bill.
   */
  eur?: number;
  allergens?: string[];
}

export interface CustomerApiDeps {
  menu: MenuItem[];
  settlement: Settlement;
  /**
   * When the real rail prices orders, the menu total is only an ESTIMATE: 2fiat
   * encodes sats in its own invoice against a live rate, and the settlement core
   * locks the order to that number. Creating a priced order here would either
   * throw amount_mismatch or silently overcharge.
   */
  price_from_rail?: boolean;
  /** EUR total per basket line, when the menu carries EUR. */
  eur_of?: (id: string) => number | undefined;
  /**
   * Called before the invoice is issued, with the basket's EUR total. The rail
   * needs it to decide how much card value to buy; the API cannot know that.
   */
  on_order_created?: (orderId: string, eur_total: number | null) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** What the customer is allowed to see. No internals, no provider refs. */
function publicOrder(s: Settlement, id: string) {
  const o = s.get(id);
  return {
    order_id: o.id,
    sats: o.sats,
    state: o.state,
    // The customer needs to know whether to act. These three flags are the whole
    // contract of the payment screen.
    can_pay: o.state === "invoiced" || o.state === "failed",
    must_not_repay: o.state === "outcome_unknown" || o.state === "paying",
    venue_ref: o.venue_ref ?? null,
    reason: o.reason ?? null,
  };
}

export function createCustomerApi(deps: CustomerApiDeps) {
  const { menu, settlement, price_from_rail = false, eur_of, on_order_created } = deps;
  const byId = new Map(menu.map((m) => [m.id, m]));

  return async function handleCustomer(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (req.method === "GET" && path === "/menu") {
      return json(200, { venue: "Three Buddies", items: menu });
    }

    if (req.method === "POST" && path === "/orders") {
      let body: { items?: Array<{ id?: string; qty?: number }> };
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const lines = Array.isArray(body.items) ? body.items : [];
      if (lines.length === 0) return json(400, { error: "empty_basket" });

      let total = 0;
      let eurTotal = 0;
      let haveEur = true;
      const priced: Array<{ id: string; name: string; qty: number; sats: number }> = [];
      for (const line of lines) {
        const item = byId.get(String(line.id ?? ""));
        if (!item) return json(400, { error: "unknown_item", id: line.id });
        const qty = Number(line.qty ?? 1);
        if (!Number.isInteger(qty) || qty <= 0 || qty > 20) {
          return json(400, { error: "bad_quantity", id: item.id });
        }
        // Price from the menu, never from the request.
        total += item.sats * qty;
        const eur = eur_of?.(item.id) ?? item.eur;
        if (typeof eur === "number" && Number.isFinite(eur)) eurTotal += eur * qty;
        else haveEur = false;
        priced.push({ id: item.id, name: item.name, qty, sats: item.sats });
      }

      const orderId = `o_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      if (price_from_rail) {
        if (!haveEur) {
          // Without EUR we cannot size the card top-up, and guessing would either
          // decline the order or park money on the card.
          return json(422, { error: "no_eur_price", detail: "rail pricing needs a EUR amount per item" });
        }
        on_order_created?.(orderId, eurTotal);
      }
      // Unpriced when the rail sets the price: the invoice is authoritative.
      if (price_from_rail) settlement.create(orderId);
      else settlement.create(orderId, total);
      let invoice;
      try {
        invoice = await settlement.invoice(orderId);
      } catch (e) {
        // If the rail cannot price it, the order must not exist as payable.
        return json(502, { error: "invoice_failed", detail: String((e as Error)?.message ?? e) });
      }
      const created = settlement.get(orderId);
      return json(201, {
        order_id: orderId,
        // `sats` is what the customer pays, and it is FINAL here either way - the
        // invoice exists and the settlement core has locked the order to it.
        // What differs is where that number came from, which the UI must show
        // honestly: a menu figure is an estimate until the rail quotes.
        sats: created.sats,
        price_source: price_from_rail ? "invoice" : "menu",
        estimate_sats: price_from_rail ? total : null,
        items: priced,
        bolt11: invoice.bolt11,
        state: created.state,
      });
    }

    const m = /^\/orders\/([^/]+)(\/pay)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      try {
        if (m[2] && req.method === "POST") {
          let key = "";
          try {
            key = String((await req.json())?.key ?? "");
          } catch { /* empty body */ }
          if (!key) return json(400, { error: "missing_idempotency_key" });
          await settlement.pay(id, key);
          return json(200, publicOrder(settlement, id));
        }
        if (req.method === "GET") {
          return json(200, publicOrder(settlement, id));
        }
      } catch (e) {
        if (e instanceof SettlementError) {
          const status = e.code === "no_order" ? 404 : 409;
          // `must_reconcile` is a 409 the UI shows as "we are checking" - it is
          // not a failure and must not invite another payment.
          return json(status, { error: e.code, detail: e.message });
        }
        return json(500, { error: "internal", detail: String((e as Error)?.message ?? e) });
      }
    }

    return json(404, { error: "not_found" });
  };
}
