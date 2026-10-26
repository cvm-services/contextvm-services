/**
 * The fiat rail, expressed in the settlement core's terms.
 *
 * Flow per order: 2fiat top-up invoice (paid in sats) -> virtual card funded ->
 * card pays the venue. The sats land with the card issuer; the venue is paid in
 * fiat from that card. This is the only path proven end to end, and it is the
 * one that keeps a refund window open until the venue is actually paid.
 *
 * Two things this adapter refuses to do, both learned from real losses:
 *
 *   1. It never derives sats from a rate. 2fiat encodes the amount in the BOLT11;
 *      the invoice's own number is what the customer is charged. (The old script
 *      assumed $0.00025820/sat against a real ~$80k BTC: a 3.1x overpay.)
 *   2. It never treats a timeout as failure. A wallet call that throws leaves the
 *      payment `outcome_unknown`, and `lookup()` asks the wallet by payment hash
 *      rather than correlating amounts in a ledger.
 *
 * Every dependency is injected: tests exercise this with no network, no wallet
 * and no card.
 */

import { bolt11Sats } from "./bolt11.ts";
import type {
  Invoice,
  InvoiceIssuer,
  Provider,
  ProviderResult,
} from "../restaurant-cvm/src/settlement.ts";

/** The subset of FiatClient this adapter needs. Injected, never imported here. */
export interface TopupRail {
  createTopup(usd: number, cardId: string): Promise<{ checkoutLink: string }>;
  resolveInvoice(checkoutLink: string): Promise<string>;
}

/** The subset of an LN wallet this adapter needs. */
export interface PayWallet {
  /** Pays a BOLT11. Resolves when the wallet knows the outcome. */
  payInvoice(bolt11: string): Promise<{ preimage?: string }>;
  /**
   * Ground truth after an unknown outcome. Never sends anything.
   *
   * Takes the INVOICE, not a hash we extracted ourselves: a hand-rolled hash
   * slice that is off by a byte silently matches the wrong payment, and that is
   * indistinguishable from a correct answer at the call site.
   */
  lookupInvoice(bolt11: string): Promise<"settled" | "pending" | "failed">;
}

export interface CardLedger {
  /** Proves the CARD is funded. An invoice paid is not a card funded. */
  balance(cardId: string): Promise<number>;
}

export interface FiatSettlementOptions {
  rail: TopupRail;
  wallet: PayWallet;
  ledger: CardLedger;
  cardId: string;
  /** What the customer is buying, in USD, for the top-up. */
  usdPerOrder: (orderId: string) => number;
}

export class FiatSettlementProvider implements InvoiceIssuer, Provider {
  /** bolt11 -> what we need to reconcile it later. */
  #byBolt11 = new Map<string, { usd: number }>();
  /** idempotency key -> bolt11, so lookup() never has to guess. */
  #byKey = new Map<string, string>();

  constructor(private opts: FiatSettlementOptions) {}

  async issue(_sats: number, orderId: string): Promise<Invoice> {
    const usd = this.opts.usdPerOrder(orderId);
    if (!(usd > 0)) throw new Error(`fiat adapter: order ${orderId} has no USD amount`);

    const topup = await this.opts.rail.createTopup(usd, this.opts.cardId);
    const bolt11 = await this.opts.rail.resolveInvoice(topup.checkoutLink);

    // bolt11Sats is the reviewed decoder (tested against real invoices). If it
    // cannot read the amount it throws, and we do not invent one.
    const amount_sats = bolt11Sats(bolt11);
    this.#byBolt11.set(bolt11, { usd });
    return {
      bolt11,
      // The invoice's own amount. This is what the customer pays, and the
      // settlement core locks the order price to it.
      amount_sats,
    };
  }

  async pay(bolt11: string, key: string): Promise<ProviderResult> {
    const meta = this.#byBolt11.get(bolt11);
    if (!meta) throw new Error("fiat adapter: paying an invoice this adapter never issued");
    this.#byKey.set(key, bolt11);

    try {
      const res = await this.opts.wallet.payInvoice(bolt11);
      // A preimage is proof of settlement. Anything else is not ours to claim.
      if (res?.preimage) return { status: "settled", provider_ref: res.preimage };
      return { status: "unknown" };
    } catch {
      // Never "failed": the payment may well have been sent.
      return { status: "unknown" };
    }
  }

  /**
   * Ask the wallet what happened, by payment hash. This is the only honest
   * source: provider ledgers are eventually consistent and correlating by amount
   * would conflate two orders of the same size.
   */
  async lookup(key: string): Promise<ProviderResult> {
    const bolt11 = this.#byKey.get(key);
    if (!bolt11) return { status: "unknown" };
    const meta = this.#byBolt11.get(bolt11);
    if (!meta) return { status: "unknown" };

    try {
      const state = await this.opts.wallet.lookupInvoice(bolt11);
      if (state === "settled") return { status: "settled", provider_ref: "invoice_settled" };
      if (state === "failed") return { status: "failed" };
      return { status: "unknown" }; // pending: still unknown, keep blocking
    } catch {
      return { status: "unknown" };
    }
  }

  /** Independent proof the card actually carries the money. */
  async cardBalance(): Promise<number> {
    return await this.opts.ledger.balance(this.opts.cardId);
  }
}
