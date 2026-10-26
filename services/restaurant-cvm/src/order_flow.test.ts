/**
 * The rule under test throughout: refund only when we KNOW the venue did not
 * take the order. Every other path must fail closed (hold, ask a human).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Settlement, type InvoiceIssuer, type Provider } from "./settlement.ts";
import { OrderFlow, type VenueOutcome, type VenueRail } from "./order_flow.ts";

let outcome: VenueOutcome | (() => Promise<VenueOutcome>);
let checkouts: string[];
let refunds: string[];

const venue: VenueRail = {
  async checkout({ order_id }) {
    checkouts.push(order_id);
    return typeof outcome === "function" ? await outcome() : outcome;
  },
};

const refundRail = {
  async refund(order_id: string, reason: string) {
    refunds.push(`${order_id}:${reason}`);
    return { ref: `rf_${refunds.length}` };
  },
};

const provider: Provider = {
  async pay() { return { status: "settled", provider_ref: "p1" }; },
  async lookup() { return { status: "settled", provider_ref: "p1" }; },
};
const issuer: InvoiceIssuer = {
  async issue(sats, orderId) { return { bolt11: `lnbc${sats}n1${orderId}`, amount_sats: sats }; },
};

let s: Settlement;
let flow: OrderFlow;

beforeEach(() => {
  checkouts = [];
  refunds = [];
  outcome = { status: "confirmed", ref: "venue_1" };
  s = new Settlement(provider, issuer, () => 1000);
  flow = new OrderFlow(s, venue, refundRail);
});

async function paidOrder(id = "o1", sats = 1334) {
  s.create(id, sats);
  await s.invoice(id);
  await s.pay(id, "tap-1");
  return id;
}

describe("happy path", () => {
  test("paid then confirmed records the venue reference", async () => {
    const id = await paidOrder();
    const r = await flow.placeOrder(id);
    expect(r.state).toBe("confirmed");
    expect(r.venue_ref).toBe("venue_1");
    expect(s.get(id).venue_ref).toBe("venue_1");
  });

  test("an unpaid order is never placed at the venue", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    const r = await flow.placeOrder("o1");
    expect(r.state).toBe("awaiting_payment");
    expect(checkouts.length).toBe(0);
  });

  test("an unresolved payment blocks placement and does not refund", async () => {
    const unknownProvider: Provider = {
      async pay() { return { status: "unknown" }; },
      async lookup() { return { status: "unknown" }; },
    };
    const s2 = new Settlement(unknownProvider, issuer, () => 1000);
    const f2 = new OrderFlow(s2, venue, refundRail);
    s2.create("o1", 1334);
    await s2.invoice("o1");
    await s2.pay("o1", "tap-1");

    const r = await f2.placeOrder("o1");
    expect(r.state).toBe("outcome_unknown");
    expect(checkouts.length).toBe(0);
    expect(refunds.length).toBe(0);
  });
});

describe("captcha is not failure", () => {
  test("requires_human parks the order: no refund, no confirm", async () => {
    const id = await paidOrder();
    outcome = { status: "requires_human", session_id: "s_9" };
    const r = await flow.placeOrder(id);
    expect(r.state).toBe("awaiting_venue_human");
    expect(r.session_id).toBe("s_9");
    expect(refunds.length).toBe(0);
    expect(s.get(id).state).toBe("paid"); // still paid, not refunded
  });

  test("after the human step, venueAccepted completes the order", async () => {
    const id = await paidOrder();
    outcome = { status: "requires_human", session_id: "s_9" };
    await flow.placeOrder(id);
    const r = await flow.venueAccepted(id, "venue_42");
    expect(r.state).toBe("confirmed");
    expect(checkouts.length).toBe(1); // no second checkout
  });
});

describe("venue failure refunds", () => {
  test("a failed venue order makes the customer whole", async () => {
    const id = await paidOrder();
    outcome = { status: "failed", reason: "item sold out" };
    const r = await flow.placeOrder(id);
    expect(r.state).toBe("refunded");
    expect(r.refund_ref).toBe("rf_1");
    expect(s.get(id).state).toBe("refunded");
    expect(refunds.length).toBe(1);
  });

  test("a venue that throws is unknown, NOT refunded", async () => {
    const id = await paidOrder();
    outcome = () => Promise.reject(new Error("chrome crashed"));
    const r = await flow.placeOrder(id);
    expect(r.state).toBe("outcome_unknown");
    // The order may exist. Refunding here pays the customer back AND delivers food.
    expect(refunds.length).toBe(0);
    expect(s.get(id).state).toBe("paid");
  });
});

describe("unknown venue outcome", () => {
  test("unknown never auto-retries the venue", async () => {
    const id = await paidOrder();
    outcome = { status: "unknown", reason: "no response" };
    await flow.placeOrder(id);
    const again = await flow.placeOrder(id);
    expect(again.state).toBe("outcome_unknown");
    expect(checkouts.length).toBe(1); // no second placement
  });

  test("a human resolving 'order does not exist' triggers the refund", async () => {
    const id = await paidOrder();
    outcome = { status: "unknown", reason: "no response" };
    await flow.placeOrder(id);
    const r = await flow.resolveUnknown(id, false, "no order at the venue");
    expect(r.state).toBe("refunded");
    expect(refunds.length).toBe(1);
  });

  test("a human resolving 'order exists' confirms without refunding", async () => {
    const id = await paidOrder();
    outcome = { status: "unknown", reason: "no response" };
    await flow.placeOrder(id);
    const r = await flow.resolveUnknown(id, true, "venue_77");
    expect(r.state).toBe("confirmed");
    expect(refunds.length).toBe(0);
  });

  test("resolving an order that is not unknown is refused", async () => {
    const id = await paidOrder();
    await expect(flow.resolveUnknown(id, true, "x")).rejects.toThrow(/not in outcome_unknown/);
  });
});

describe("idempotency", () => {
  test("placing twice does not place two orders", async () => {
    const id = await paidOrder();
    await flow.placeOrder(id);
    await flow.placeOrder(id);
    expect(checkouts.length).toBe(1);
  });

  test("a confirmed order cannot be refunded by re-running the flow", async () => {
    const id = await paidOrder();
    await flow.placeOrder(id);
    outcome = { status: "failed", reason: "late failure" };
    const r = await flow.placeOrder(id);
    expect(r.state).toBe("confirmed");
    expect(refunds.length).toBe(0);
  });
});
