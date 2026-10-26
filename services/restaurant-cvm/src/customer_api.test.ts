/**
 * The customer API's money rules: the server prices the basket, and the payment
 * state reported is the rail's, never the client's.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Settlement, type Provider } from "./settlement.ts";
import { createCustomerApi, type MenuItem } from "./customer_api.ts";

const MENU: MenuItem[] = [
  { id: "m1", name: "Margherita", sats: 890 },
  { id: "m3", name: "Birra", sats: 320 },
];

let railStatus: "settled" | "unknown" | "failed";
const provider: Provider = {
  async pay() { return railStatus === "settled" ? { status: "settled", provider_ref: "r" } : { status: railStatus }; },
  async lookup() { return railStatus === "settled" ? { status: "settled", provider_ref: "r" } : { status: railStatus }; },
};
const issuer = {
  async issue(sats: number, id: string) { return { bolt11: `lnbc${sats * 10}n1${id}`.padEnd(120, "0"), amount_sats: sats }; },
};

let api: ReturnType<typeof createCustomerApi>;
let settlement: Settlement;

const post = (path: string, body: unknown) =>
  api(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const get = (path: string) => api(new Request(`http://x${path}`));

beforeEach(() => {
  railStatus = "settled";
  settlement = new Settlement(provider, issuer);
  api = createCustomerApi({ menu: MENU, settlement });
});

describe("the server prices the basket", () => {
  test("total comes from the menu", async () => {
    const r = await post("/orders", { items: [{ id: "m1", qty: 2 }, { id: "m3", qty: 1 }] });
    const body = await r.json();
    expect(r.status).toBe(201);
    expect(body.sats).toBe(2100); // 890*2 + 320
  });

  test("a client-supplied price is ignored", async () => {
    const r = await post("/orders", { items: [{ id: "m1", qty: 1, sats: 1, price: 1 }] });
    expect((await r.json()).sats).toBe(890);
  });

  test("an unknown item is refused", async () => {
    const r = await post("/orders", { items: [{ id: "nope", qty: 1 }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("unknown_item");
  });

  test("a zero or fractional quantity is refused", async () => {
    expect((await post("/orders", { items: [{ id: "m1", qty: 0 }] })).status).toBe(400);
    expect((await post("/orders", { items: [{ id: "m1", qty: 1.5 }] })).status).toBe(400);
  });

  test("an absurd quantity is refused (fat-finger guard)", async () => {
    expect((await post("/orders", { items: [{ id: "m1", qty: 999 }] })).status).toBe(400);
  });

  test("an empty basket is refused", async () => {
    expect((await post("/orders", { items: [] })).status).toBe(400);
  });
});

describe("payment state is the rail's, not the client's", () => {
  test("paid only when the rail settles", async () => {
    const o = await (await post("/orders", { items: [{ id: "m1", qty: 1 }] })).json();
    const p = await (await post(`/orders/${o.order_id}/pay`, { key: "k1" })).json();
    expect(p.state).toBe("paid");
    expect(p.can_pay).toBe(false);
    expect(p.must_not_repay).toBe(false);
  });

  test("unknown tells the customer not to repay", async () => {
    railStatus = "unknown";
    const o = await (await post("/orders", { items: [{ id: "m1", qty: 1 }] })).json();
    const p = await (await post(`/orders/${o.order_id}/pay`, { key: "k1" })).json();
    expect(p.state).toBe("outcome_unknown");
    expect(p.must_not_repay).toBe(true);
    expect(p.can_pay).toBe(false); // the UI must not offer another payment
  });

  test("a second payment while unknown is refused with must_reconcile", async () => {
    railStatus = "unknown";
    const o = await (await post("/orders", { items: [{ id: "m1", qty: 1 }] })).json();
    await post(`/orders/${o.order_id}/pay`, { key: "k1" });
    const again = await post(`/orders/${o.order_id}/pay`, { key: "k2" });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("must_reconcile");
  });

  test("paying without an idempotency key is refused", async () => {
    const o = await (await post("/orders", { items: [{ id: "m1", qty: 1 }] })).json();
    expect((await post(`/orders/${o.order_id}/pay`, {})).status).toBe(400);
  });

  test("a failed rail lets the customer retry", async () => {
    railStatus = "failed";
    const o = await (await post("/orders", { items: [{ id: "m1", qty: 1 }] })).json();
    const p = await (await post(`/orders/${o.order_id}/pay`, { key: "k1" })).json();
    expect(p.state).toBe("failed");
    expect(p.can_pay).toBe(true);
  });

  test("another customer's order id is not readable", async () => {
    expect((await get("/orders/o_does_not_exist")).status).toBe(404);
  });
});

// --- when the rail sets the price, the menu is an estimate --------------------
describe("rail-priced orders", () => {
  test("the order is created unpriced and takes the invoice's amount", async () => {
    // The rail quotes sats itself; a menu-derived price would either throw
    // amount_mismatch or overcharge, so the order must start unpriced.
    const railIssuer = {
      async issue(_sats: number, orderId: string) {
        return { bolt11: `lnbc9990n1${orderId}`.padEnd(140, "0"), amount_sats: 999 };
      },
    };
    const railSettlement = new Settlement(provider, railIssuer);
    const withEur = MENU.map((m) => ({ ...m, eur: m.id === "m1" ? 14 : 5 }));
    let seen: { id: string; eur: number | null } | null = null;
    const api2 = createCustomerApi({
      menu: withEur, settlement: railSettlement, price_from_rail: true,
      on_order_created: (id, eur) => { seen = { id, eur }; },
    });

    const res = await api2(new Request("http://x/orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: "m1", qty: 1 }] }),
    }));
    const body = await res.json();

    expect(body.sats).toBe(999);              // the invoice, not the 890 menu price
    expect(body.price_source).toBe("invoice");
    expect(body.estimate_sats).toBe(890);     // shown as an estimate, clearly labelled
    expect(seen!.eur).toBe(14);               // the EUR bill the card must cover
  });

  test("a menu-priced order still reports its price as final", async () => {
    const res = await post("/orders", { items: [{ id: "m1", qty: 1 }] });
    const body = await res.json();
    expect(body.price_source).toBe("menu");
    expect(body.estimate_sats).toBeNull();
  });
});

describe("rail pricing without EUR is refused", () => {
  test("an item with no EUR price cannot be rail-priced", async () => {
    // Guessing the EUR amount would either decline the order or park money on the
    // card, so this is a refusal rather than a fallback.
    const railSettlement = new Settlement(provider, issuer);
    const api2 = createCustomerApi({ menu: MENU, settlement: railSettlement, price_from_rail: true });
    const res = await api2(new Request("http://x/orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: "m1", qty: 1 }] }),
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_eur_price");
  });
});
