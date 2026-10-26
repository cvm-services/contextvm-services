/**
 * The price chain and the wiring. The dangerous number here is the FX factor:
 * guessing it either declines the order or parks money on a card — so it must be
 * configured, explained, and rounded in the direction that never under-funds.
 */
import { describe, expect, test } from "bun:test";
import { buildRail, readRailConfig, usdForEur, RailConfigError } from "./rail_wiring.ts";

const env = (o: Record<string, string>) => (n: string) => o[n];

describe("the FX factor is configured, never inferred", () => {
  test("missing factor refuses to boot rather than defaulting", () => {
    expect(() => readRailConfig(env({}))).toThrow(RailConfigError);
  });

  test("a factor without provenance is refused: an unexplained price is unauditable", () => {
    expect(() => readRailConfig(env({ CVM_USD_PER_EUR: "1.1", CVM_RAIL_CARD_ID: "c" })))
      .toThrow(/SOURCE/);
  });

  test("a nonsense factor is refused", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      expect(() => readRailConfig(env({
        CVM_USD_PER_EUR: bad, CVM_USD_PER_EUR_SOURCE: "s", CVM_RAIL_CARD_ID: "c",
      }))).toThrow(RailConfigError);
    }
  });

  test("a complete config is accepted and keeps its provenance", () => {
    const c = readRailConfig(env({
      CVM_USD_PER_EUR: "1.1", CVM_USD_PER_EUR_SOURCE: "ECB 2026-10-26", CVM_RAIL_CARD_ID: "card_1",
    }));
    expect(c.usd_per_eur).toBe(1.1);
    expect(c.usd_per_eur_source).toContain("ECB");
    expect(c.card_id).toBe("card_1");
  });
});

describe("rounding never under-funds the venue", () => {
  const cfg = { usd_per_eur: 1.1, usd_per_eur_source: "test", card_id: "c" };

  test("a bill rounds UP to whole cents", () => {
    // 14.00 EUR * 1.1 = 15.40 exactly
    expect(usdForEur(14, cfg)).toBeCloseTo(15.4, 5);
    // 12.35 * 1.1 = 13.585 -> must become 13.59, not 13.58
    expect(usdForEur(12.35, cfg)).toBeCloseTo(13.59, 5);
  });

  test("a cent of shortfall is a declined order, so rounding is not cosmetic", () => {
    expect(usdForEur(0.01, cfg)).toBeGreaterThan(0);
  });

  test("a non-positive bill is refused", () => {
    expect(() => usdForEur(0, cfg)).toThrow();
    expect(() => usdForEur(-5, cfg)).toThrow();
  });
});

describe("wiring", () => {
  const fakeClient = {
    async requestTopup(_id: string, body: { topupValue: string }) {
      return { checkoutLink: `https://2fiat.com/pay/i/x?usd=${body.topupValue}` };
    },
    async resolveInvoiceFromCheckout() {
      return "lnbc13340n1p4dfeg4pp5kw68znxetgr36d33entwxyz";
    },
    async cards() {
      return [{ id: "card_1", balance: "3.38" }];
    },
    pickCard(cards: Array<{ id: string }>, id?: string) {
      return cards.find((c) => c.id === id) ?? cards[0];
    },
  } as never;

  const wallet = {
    async payInvoice() { return { preimage: "abc" }; },
    async lookupInvoice() { return "settled" as const; },
    async balanceSats() { return 10_000; },
  };

  test("the top-up is requested in dollars, formatted to cents", async () => {
    const rail = buildRail({
      client: fakeClient, wallet,
      config: { usd_per_eur: 1.1, usd_per_eur_source: "t", card_id: "card_1" },
      usdPerOrder: () => 15.4,
    });
    const inv = await rail.provider.issue(0, "o1");
    expect(inv.amount_sats).toBe(1334); // from the invoice, never computed by us
  });

  test("no checkout link is an error, not a silent null", async () => {
    const broken = { ...(fakeClient as object), async requestTopup() { return {}; } } as never;
    const rail = buildRail({
      client: broken, wallet,
      config: { usd_per_eur: 1.1, usd_per_eur_source: "t", card_id: "card_1" },
      usdPerOrder: () => 5,
    });
    await expect(rail.provider.issue(0, "o1")).rejects.toThrow(/checkout link/);
  });

  test("a checkout page that is not a BOLT11 is refused", async () => {
    const broken = {
      ...(fakeClient as object),
      async resolveInvoiceFromCheckout() { return "<html>not an invoice</html>"; },
    } as never;
    const rail = buildRail({
      client: broken, wallet,
      config: { usd_per_eur: 1.1, usd_per_eur_source: "t", card_id: "card_1" },
      usdPerOrder: () => 5,
    });
    await expect(rail.provider.issue(0, "o1")).rejects.toThrow(/BOLT11/);
  });

  test("the card balance is read as a number, not a string", async () => {
    const rail = buildRail({
      client: fakeClient, wallet,
      config: { usd_per_eur: 1.1, usd_per_eur_source: "t", card_id: "card_1" },
      usdPerOrder: () => 5,
    });
    expect(await rail.provider.cardBalance()).toBe(3.38);
  });
});
