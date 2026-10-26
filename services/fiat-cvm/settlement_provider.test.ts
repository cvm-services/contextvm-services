/**
 * The fiat rail behind the settlement core. No network, no wallet, no card:
 * everything is injected, because a test that needs a real wallet cannot run on
 * every commit and will be skipped exactly when it matters.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Settlement } from "../restaurant-cvm/src/settlement.ts";
import { FiatSettlementProvider, type PayWallet, type TopupRail } from "./settlement_provider.ts";

// Real-shaped invoice: lnbc<amount>n... with a full-length data part.
const inv = (sats: number) => `lnbc${sats * 10}n1p4dfeg4pp5kw68znxetgr36d33entwxyz1234567890abcdefghijklmnopqrstuvwxyz234567890abcdefghijklmnopqrstuvwxyz234567890`;

let topups: Array<{ usd: number; cardId: string }>;
let paid: string[];
let walletState: "settled" | "pending" | "failed";
let walletThrows: boolean;
let preimage: string | undefined;

const rail: TopupRail = {
  async createTopup(usd, cardId) {
    topups.push({ usd, cardId });
    return { checkoutLink: `https://2fiat.com/pay/i/${topups.length}` };
  },
  async resolveInvoice() {
    return inv(1334); // the provider quotes the sats; we never compute them
  },
};

const wallet: PayWallet = {
  async payInvoice(b) {
    paid.push(b);
    if (walletThrows) throw new Error("socket hang up");
    return { preimage };
  },
  async lookupInvoice() {
    return walletState;
  },
};

const ledger = { async balance() { return 3.38; } };

let provider: FiatSettlementProvider;
let s: Settlement;

beforeEach(() => {
  topups = [];
  paid = [];
  walletState = "settled";
  walletThrows = false;
  preimage = "deadbeef";
  provider = new FiatSettlementProvider({
    rail,
    wallet,
    ledger,
    cardId: "card_1",
    usdPerOrder: () => 1.07,
  });
  s = new Settlement(provider, provider, () => 1000);
});

describe("invoice from the fiat rail", () => {
  test("the order price is the invoice's own amount, not a rate we computed", async () => {
    s.create("o1"); // unpriced: the rail quotes sats
    const invoice = await s.invoice("o1");
    expect(invoice.amount_sats).toBe(1334);
    expect(s.get("o1").sats).toBe(1334); // locked to the invoice
  });

  test("the price is locked once: a second invoice() returns the same one", async () => {
    s.create("o1");
    const a = await s.invoice("o1");
    const b = await s.invoice("o1");
    expect(b.bolt11).toBe(a.bolt11);
    expect(topups.length).toBe(1); // no second top-up was created
  });

  test("an unpriced order cannot be paid before it is invoiced", async () => {
    s.create("o1");
    await expect(s.pay("o1", "tap-1")).rejects.toThrow(/bad_state/);
  });
});

describe("paying through the fiat rail", () => {
  test("a preimage means settled", async () => {
    s.create("o1");
    await s.invoice("o1");
    const o = await s.pay("o1", "tap-1");
    expect(o.state).toBe("paid");
    expect(paid.length).toBe(1);
  });

  test("a wallet that throws is unknown, never failed", async () => {
    walletThrows = true;
    s.create("o1");
    await s.invoice("o1");
    expect((await s.pay("o1", "tap-1")).state).toBe("outcome_unknown");
    // and the unresolved attempt blocks a second payment
    await expect(s.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
  });

  test("no preimage is unknown, not success", async () => {
    preimage = undefined;
    s.create("o1");
    await s.invoice("o1");
    expect((await s.pay("o1", "tap-1")).state).toBe("outcome_unknown");
  });

  test("lookup settles it without sending again", async () => {
    walletThrows = true;
    s.create("o1");
    await s.invoice("o1");
    await s.pay("o1", "tap-1");

    walletThrows = false;
    walletState = "settled";
    const o = await s.reconcile("o1");
    expect(o.state).toBe("paid");
    expect(paid.length).toBe(1); // reconcile asked, it did not pay
  });

  test("lookup may conclude failed, unlocking a safe retry", async () => {
    walletThrows = true;
    s.create("o1");
    await s.invoice("o1");
    await s.pay("o1", "tap-1");

    walletThrows = false;
    walletState = "failed";
    expect((await s.reconcile("o1")).state).toBe("failed");

    walletState = "settled";
    expect((await s.pay("o1", "tap-2")).state).toBe("paid");
  });

  test("pending stays unknown and keeps blocking", async () => {
    walletThrows = true;
    s.create("o1");
    await s.invoice("o1");
    await s.pay("o1", "tap-1");

    walletThrows = false;
    walletState = "pending";
    expect((await s.reconcile("o1")).state).toBe("outcome_unknown");
    await expect(s.pay("o1", "tap-2")).rejects.toThrow(/must_reconcile/);
  });

  test("paying an invoice this adapter never issued is refused", async () => {
    await expect(provider.pay("lnbc9999n1unknown", "k")).rejects.toThrow(/never issued/);
  });
});

describe("card balance is the independent proof", () => {
  test("the adapter can read the funded balance", async () => {
    expect(await provider.cardBalance()).toBe(3.38);
  });
});
