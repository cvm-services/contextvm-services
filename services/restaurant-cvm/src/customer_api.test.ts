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
