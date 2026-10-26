/**
 * Money-safety tests. Each one encodes a way real money was or could be lost.
 * If one of these fails, the answer is "do not ship", not "adjust the assertion".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Settlement, SettlementError, type InvoiceIssuer, type Provider, type ProviderResult } from "./settlement.ts";

let paid: Array<{ bolt11: string; key: string }>;
let lookups: number;
let nextResult: ProviderResult;

const provider: Provider = {
  async pay(bolt11, key) {
    paid.push({ bolt11, key });
    return nextResult;
  },
  async lookup() {
    lookups++;
    return nextResult;
  },
};

/** Issues an invoice for `sats` unless overridden — the override is how the
 *  mispriced-invoice case is simulated. */
let issueOverride: number | null = null;
const issuer: InvoiceIssuer = {
  async issue(sats, orderId) {
    return {
      bolt11: `lnbc${sats}n1${orderId}`,
      payment_hash: `h_${orderId}`,
      amount_sats: issueOverride ?? sats,
    };
  },
};

let s: Settlement;
beforeEach(() => {
  paid = [];
  lookups = 0;
  issueOverride = null;
  nextResult = { status: "settled", provider_ref: "ref_1" };
  s = new Settlement(provider, issuer, () => 1000);
});

describe("no overpay", () => {
  test("an invoice encoding more than the order is refused, not paid", async () => {
    issueOverride = 4000; // order is 1334
    s.create("o1", 1334);
    await expect(s.invoice("o1")).rejects.toThrow(/amount_mismatch/);
    expect(paid.length).toBe(0);
  });

  test("the invoice amount is never recomputed from a rate", async () => {
    s.create("o1", 1334);
    const inv = await s.invoice("o1");
    expect(inv.amount_sats).toBe(1334);
    expect(inv.bolt11).toContain("1334n");
  });

  test("re-invoicing returns the same invoice (a reload must not double-charge)", async () => {
    s.create("o1", 1334);
    const a = await s.invoice("o1");
    const b = await s.invoice("o1");
    expect(b.bolt11).toBe(a.bolt11);
  });
});

describe("no double pay", () => {
  test("the same idempotency key never pays twice", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");
    await s.pay("o1", "tap-1"); // duplicate submit
    expect(paid.length).toBe(1);
    expect(s.get("o1").state).toBe("paid");
  });

  test("a second tap with a NEW key on a paid order does nothing", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");
    await s.pay("o1", "tap-2");
    expect(paid.length).toBe(1);
  });

  test("a timeout becomes outcome_unknown and BLOCKS further payment", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    nextResult = { status: "unknown" };
    await s.pay("o1", "tap-1");
    expect(s.get("o1").state).toBe("outcome_unknown");

    // The whole point: a different key must NOT slip through while unresolved.
    await expect(s.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
    expect(paid.length).toBe(1);
  });

  test("a provider that THROWS is unknown, not failed (and is not retried)", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    const throwing: Provider = {
      async pay() { paid.push({ bolt11: "x", key: "k" }); throw new Error("socket hang up"); },
      async lookup() { return { status: "settled", provider_ref: "ref_after" }; },
    };
    const t = new Settlement(throwing, issuer, () => 1000);
    t.create("o1", 1334);
    await t.invoice("o1");
    const o = await t.pay("o1", "tap-1");
    expect(o.state).toBe("outcome_unknown"); // NOT failed
    await expect(t.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
  });

  test("reconcile settles it, and the settled attempt is counted once", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    nextResult = { status: "unknown" };
    await s.pay("o1", "tap-1");

    nextResult = { status: "settled", provider_ref: "ref_real" };
    const o = await s.reconcile("o1");
    expect(o.state).toBe("paid");
    expect(o.attempts.filter((a) => a.outcome === "settled").length).toBe(1);
    expect(paid.length).toBe(1); // reconcile never re-sends
  });

  test("reconcile may conclude 'failed', which unlocks a safe retry", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    nextResult = { status: "unknown" };
    await s.pay("o1", "tap-1");

    nextResult = { status: "failed" };
    expect((await s.reconcile("o1")).state).toBe("failed");

    nextResult = { status: "settled", provider_ref: "ref_2" };
    const o = await s.pay("o1", "tap-2");
    expect(o.state).toBe("paid");
    expect(paid.length).toBe(2); // one unknown + one real attempt, only one settled
    expect(o.attempts.filter((a) => a.outcome === "settled").length).toBe(1);
  });

  test("still-unknown reconcile keeps blocking (waiting is free, guessing is not)", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    nextResult = { status: "unknown" };
    await s.pay("o1", "tap-1");
    expect((await s.reconcile("o1")).state).toBe("outcome_unknown");
    await expect(s.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
  });
});

describe("paid is not confirmed", () => {
  test("confirm refuses an unpaid order", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    expect(() => s.confirm("o1", "venue_1")).toThrow(/not_paid/);
  });

  test("confirm after paid records the venue reference, idempotently", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");
    s.confirm("o1", "venue_1");
    s.confirm("o1", "venue_1");
    expect(s.get("o1").venue_ref).toBe("venue_1");
  });
});

describe("refunds", () => {
  test("refund requires a settled payment and records a reference", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");
    const o = s.refund("o1", "venue rejected the order", "refund_abc");
    expect(o.state).toBe("refunded");
    expect(o.refund_ref).toBe("refund_abc");
  });

  test("an unpaid order cannot be refunded (nothing to refund)", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    expect(() => s.refund("o1", "x", "r")).toThrow(/not_paid/);
  });

  test("a refunded order cannot be paid again", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");
    s.refund("o1", "venue closed", "refund_1");
    await s.pay("o1", "tap-2");
    expect(paid.length).toBe(1);
  });
});

describe("crash safety", () => {
  test("an attempt journaled before the call survives as in_flight, not as failure", async () => {
    // Simulate the process dying mid-payment: the provider never answers.
    const hanging: Provider = {
      pay() { return new Promise<ProviderResult>(() => {}); },
      async lookup() { return { status: "settled", provider_ref: "ref_after_crash" }; },
    };
    const t = new Settlement(hanging, issuer, () => 1000);
    t.create("o1", 1334);
    await t.invoice("o1");
    void t.pay("o1", "tap-1"); // never resolves

    // A fresh process sees the journaled attempt and must ask, not retry.
    const o = t.get("o1");
    expect(o.attempts.length).toBe(1);
    expect(o.attempts[0].outcome).toBe("in_flight");
    await expect(t.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
  });
});

describe("ledger", () => {
  test("every settled sat is accounted for", async () => {
    s.create("o1", 1334);
    await s.invoice("o1");
    await s.pay("o1", "tap-1");

    s.create("o2", 500);
    await s.invoice("o2");
    nextResult = { status: "unknown" };
    await s.pay("o2", "tap-1");

    const l = s.reconcileLedger();
    expect(l.settled_attempts).toBe(1);
    expect(l.paid).toBe(1334); // o2 is unknown: not counted as paid, not lost
    expect(l.refunded).toBe(0);
  });

  test("a negative or fractional amount is refused", () => {
    expect(() => s.create("bad", -1)).toThrow(SettlementError);
    expect(() => s.create("bad2", 1.5)).toThrow(SettlementError);
  });
});
