/**
 * Wiring the real rail into the customer API.
 *
 * Kept out of serve_customer.ts so it can be tested without a wallet, a card or a
 * network: the boot script decides WHEN to build this, the factory decides HOW,
 * and every dependency arrives as an argument.
 *
 * THE PRICE CHAIN, stated plainly because it is where money goes wrong:
 *
 *   venue charges EUR  ->  we fund a USD card  ->  2fiat issues a sats invoice
 *                                                          |
 *                                        the customer pays THESE sats
 *
 * So two rates exist and they are different things:
 *   - EUR -> USD: how much card value to buy for a given venue bill. A GUESS here
 *     means the card is short (order declined) or the float grows (money parked).
 *     Neither is a loss, but both must be visible, so the factor is configured and
 *     recorded, never inferred.
 *   - USD -> sats: NOT ours. 2fiat encodes it in the invoice and the settlement
 *     core locks the order to that number. We never compute it.
 */

import type { Card, FiatClient } from "../../fiat-cvm/fiat_client.ts";
import type { TopupRail, PayWallet, CardLedger } from "../../fiat-cvm/settlement_provider.ts";
import { FiatSettlementProvider } from "../../fiat-cvm/settlement_provider.ts";

export interface LnWalletLike {
  payInvoice(bolt11: string): Promise<{ preimage?: string }>;
  lookupInvoice(bolt11: string): Promise<"settled" | "pending" | "failed">;
  balanceSats(): Promise<number>;
}

export interface RailConfig {
  /** USD of card value to buy per EUR of venue bill. Must come from config. */
  usd_per_eur: number;
  /** Where that number came from. Recorded with every order so it can be audited. */
  usd_per_eur_source: string;
  card_id: string;
}

export class RailConfigError extends Error {}

/** Refuses to guess. A default here would silently short-fund or over-fund. */
export function readRailConfig(env: (n: string) => string | undefined): RailConfig {
  const raw = env("CVM_USD_PER_EUR");
  const source = env("CVM_USD_PER_EUR_SOURCE");
  const card = env("CVM_RAIL_CARD_ID");

  if (!raw) {
    throw new RailConfigError(
      "CVM_USD_PER_EUR is not set: refusing to guess how much card value a venue bill needs",
    );
  }
  const usd_per_eur = Number(raw);
  if (!Number.isFinite(usd_per_eur) || usd_per_eur <= 0) {
    throw new RailConfigError(`CVM_USD_PER_EUR must be a positive number, got ${raw}`);
  }
  if (!source) {
    throw new RailConfigError(
      "CVM_USD_PER_EUR_SOURCE is not set: an unexplained FX factor is an unauditable price",
    );
  }
  if (!card) throw new RailConfigError("CVM_RAIL_CARD_ID is not set");

  return { usd_per_eur, usd_per_eur_source: source, card_id: card };
}

/** EUR bill -> USD of card value. Rounded up: a card short by a cent is a declined order. */
export function usdForEur(eur: number, cfg: RailConfig): number {
  if (!Number.isFinite(eur) || eur <= 0) throw new RailConfigError(`bad EUR amount: ${eur}`);
  // Kill binary noise BEFORE rounding up: 14 * 1.1 is 15.400000000000002 in
  // floating point, and a raw ceil would charge 15.41 for a 15.40 bill. Six
  // decimals is far below a cent and well above the noise.
  const cents = Math.ceil(Number((eur * cfg.usd_per_eur * 100).toFixed(6)));
  return cents / 100;
}

export function makeTopupRail(client: FiatClient): TopupRail {
  return {
    async createTopup(usd: number, cardId: string) {
      const res = await client.requestTopup(cardId, {
        topupValue: usd.toFixed(2),
        selectedMethod: "BTC-LN",
      });
      if (!res?.checkoutLink) throw new Error("2fiat returned no checkout link for the top-up");
      return { checkoutLink: res.checkoutLink };
    },
    async resolveInvoice(checkoutLink: string) {
      const bolt11 = await client.resolveInvoiceFromCheckout(checkoutLink);
      if (!bolt11?.startsWith("lnbc")) throw new Error("checkout page did not yield a BOLT11");
      return bolt11;
    },
  };
}

export function makeWallet(wallet: LnWalletLike): PayWallet {
  return {
    async payInvoice(bolt11: string) {
      const r = await wallet.payInvoice(bolt11);
      return { preimage: r?.preimage };
    },
    // Takes the invoice, not a hash we sliced ourselves: a hand-rolled hash that is
    // off by a byte silently matches the wrong payment.
    async lookupInvoice(bolt11: string) {
      return await wallet.lookupInvoice(bolt11);
    },
  };
}

/** Independent proof the CARD is funded. An invoice paid is not a card funded. */
export function makeLedger(client: FiatClient, cardId: string): CardLedger {
  return {
    async balance() {
      const cards: Card[] = await client.cards();
      const card = client.pickCard(cards, cardId);
      return Number(card.balance ?? 0);
    },
  };
}

export interface RailBundle {
  provider: FiatSettlementProvider;
  /** Called by the order route: how much card value this order needs, in USD. */
  usdFor: (eur: number) => number;
  config: RailConfig;
}

export function buildRail(opts: {
  client: FiatClient;
  wallet: LnWalletLike;
  config: RailConfig;
  /** Per-order USD target. Supplied by the caller, which knows the basket. */
  usdPerOrder: (orderId: string) => number;
}): RailBundle {
  const { client, wallet, config, usdPerOrder } = opts;
  const provider = new FiatSettlementProvider({
    rail: makeTopupRail(client),
    wallet: makeWallet(wallet),
    ledger: makeLedger(client, config.card_id),
    cardId: config.card_id,
    usdPerOrder,
  });
  return {
    provider,
    usdFor: (eur: number) => usdForEur(eur, config),
    config,
  };
}
