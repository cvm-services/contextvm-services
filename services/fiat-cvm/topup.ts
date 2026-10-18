/**
 * R3 top-up: put money ON a 2fiat card.
 *
 * WHY THIS EXISTS
 *   The CVM exposed cards / quote / pay / status and no way to FUND a card, so the
 *   product's chain had a hole:
 *
 *       customer sats -> melt -> [ NOTHING ] -> card pays the venue
 *
 *   The provider contract was measured during recon:
 *     POST /api/v1/prepaid-cards/topup/{cardId}/check-availability {"topupValue":"N"}
 *     POST /api/v1/prepaid-cards/topup/{cardId}
 *          {"topupValue":"N","selectedMethod":"BTC-LN"}
 *       -> { amount, checkoutLink, checkout: { defaultPaymentMethod: "BTC-LN" } }
 *   fee 6.5%, published in the card product metadata as `topup_fee`.
 *
 * MONEY-SAFETY DISCIPLINE (same as the melt work)
 *   * This returns an INVOICE. It NEVER claims a card is funded — only the card
 *     BALANCE moving (via `status`) can show that.
 *   * The amount actually charged is the provider's own `amount`; if that
 *     disagrees with our fee-inclusive quote we surface the discrepancy instead of
 *     silently trusting one side.
 *   * A checkoutLink that is not a bolt11 is an error. A URL is not a payment.
 *   * An unknown card id is refused BEFORE any write.
 */

import { FiatClient, FiatError, type Card } from "./fiat_client.ts";

export interface TopupInput {
  amount: number;
  card_id?: string;
}

export interface TopupResult {
  kind: "invoice";
  cardId: string;
  /** Sats-equivalent fiat figure the provider will charge, fee included. */
  chargedAmount: number;
  subtotal: number;
  fee: number;
  /** BOLT11 the facilitator must pay to fund the card. */
  bolt11: string;
  /** Anything the caller should know before paying. */
  note: string;
  /** Set when the provider's number disagrees with our fee-inclusive quote. */
  feeDiscrepancy?: string;
}

const BOLT11 = /^ln(bc|tb|bcrt)[0-9a-z]+$/i;

/** The MCP tool descriptor, so a client can discover top-up. */
export const TOPUP_TOOL = {
  name: "topup",
  description:
    "Create a Lightning invoice that funds a card. Returns an INVOICE to pay — it never claims the card is funded; confirm with `status` (balance moved).",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Card-currency amount to add, before the top-up fee." },
      card_id: { type: "string", description: "Card to fund; the richest is chosen when omitted." },
    },
    required: ["amount"],
    additionalProperties: false,
  },
} as const;

export async function topupFiat(client: FiatClient, input: TopupInput): Promise<TopupResult> {
  const amount = Number(input?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new FiatError("topup amount must be a positive number");
  }

  const cards = await client.cards();
  let card: Card;
  if (input.card_id) {
    const found = cards.find((c) => c.id === input.card_id);
    if (!found) throw new FiatError(`card ${input.card_id} is not in this wallet`);
    card = found;
  } else {
    if (cards.length === 0) throw new FiatError("this wallet has no cards");
    card = [...cards].sort((a, b) => b.balance - a.balance)[0];
  }

  const ourQuote = client.quoteTotal(card, amount);

  // Ask the provider for the real charge and an invoice. This is the only call that
  // can create a payable artefact, so it happens after every local validation.
  const res = await client.requestTopup(card.id, {
    topupValue: String(amount),
    selectedMethod: "BTC-LN",
  });

  const charged = Number(res.amount);
  if (!Number.isFinite(charged) || charged <= 0) {
    throw new FiatError(`topup: provider returned no usable amount (${JSON.stringify(res.amount)})`);
  }

  const link = String(res.checkoutLink ?? "").trim();
  if (!link) throw new FiatError("topup: provider returned no checkoutLink — nothing to pay");
  if (!BOLT11.test(link)) {
    // A checkout URL means a HUMAN has to open a page. That is not an automation
    // path, and calling it a payment would be a lie.
    throw new FiatError(
      `topup: checkoutLink is not a BOLT11 invoice (got "${link.slice(0, 40)}…"). ` +
        `This top-up needs a human in a browser; it cannot be paid from the NWC rail.`,
    );
  }

  // Compare the provider's charge with our own fee-inclusive quote. Disagreement is
  // information, not something to paper over.
  const fee = Math.round((charged - amount) * 100) / 100;
  let feeDiscrepancy: string | undefined;
  if (Math.abs(charged - ourQuote.total) > 0.01) {
    feeDiscrepancy =
      `fee discrepancy: we quoted ${ourQuote.total.toFixed(2)} (fee ${ourQuote.fee.toFixed(2)} at ` +
      `${((card.topup_fee ?? 0) * 100).toFixed(1)}%) but the provider charges ${charged.toFixed(2)}. ` +
      `The provider's number is what will be debited.`;
  }

  return {
    kind: "invoice",
    cardId: card.id,
    chargedAmount: charged,
    subtotal: amount,
    fee,
    bolt11: link,
    note:
      `NOT FUNDED YET. Pay this invoice to add ${amount} ${card.currency} to ${card.masked_number}. ` +
      `The card is only funded once its balance moves — confirm with the status tool.`,
    feeDiscrepancy,
  };
}
