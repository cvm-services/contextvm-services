/**
 * Tool surface for the 2fiat CVM (ADR-0016).
 *
 * The contract is deliberately narrow and honest:
 *
 *  - `cards`  read-only, lists the wallet's cards + balances
 *  - `quote`  read-only, resolves card + fee-inclusive total for an amount
 *  - `pay`    moves money. Returns `captured` ONLY on observed evidence, and
 *             otherwise returns `requires_3ds` with the approval URL, or
 *             `declined`. It never reports success it did not see.
 *  - `status` read-only, re-reads the card balance to corroborate a payment
 *
 * PAN/CVV are never read, logged, or returned.
 */

import { type Card, FiatClient, FiatError } from "./fiat_client.ts";

/** What the facilitator console sends to `pay`. */
export interface PayInput {
  card_id?: string;
  /** The venue's charge, in the card's currency (never client-computed). */
  amount: number;
  currency?: string;
  /** Free text for the merchant descriptor / ledger. */
  memo?: string;
  venue_slug?: string;
  venue_reference?: string;
}

export interface PayResult {
  state: "captured" | "requires_3ds" | "declined";
  reference: string | null;
  card_id: string;
  amount: number;
  currency: string;
  /** Present only when state === "requires_3ds". */
  challenge_url?: string;
  /** Human-readable reason, always present on non-captured states. */
  detail?: string;
}

/**
 * The payment attempt itself. Upstream: the wallet's card product is 3D Secure
 * enabled, so a fully unattended capture cannot be guaranteed. Until the pay
 * endpoint is wired against a live order, this refusal is the honest answer —
 * it must NOT be replaced with a fabricated success.
 */
export async function payFiat(client: FiatClient, input: PayInput): Promise<PayResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new FiatError("amount must be a positive number");
  }
  const cards = await client.cards();
  const card = client.pickCard(cards, input.card_id);
  const q = client.quoteTotal(card, input.amount);

  if (card.balance < q.total) {
    return {
      state: "declined",
      reference: null,
      card_id: card.id,
      amount: q.total,
      currency: card.currency,
      detail: `card balance ${card.balance} ${card.currency} is below the fee-inclusive total ${q.total}`,
    };
  }

  // Not wired to a live capture yet. Returning a truthful "cannot complete
  // unattended" beats inventing a reference — the console shows the manual
  // fallback (pay at the venue) exactly as before ADR-0016.
  //
  // THE REASON IS MEASURED, NOT ASSUMED (2026-10-18, no charge attempted):
  //   POST prepaid-cards/pay              -> 404 product_not_found
  //        (resolves a card PRODUCT to buy, NOT a charge on an existing card)
  //   POST prepaid-cards/details/{id}     -> 200 {cardNumber, cvv, expirationDate}
  //   GET  prepaid-cards/details/{id}/otp -> 200   (the OTP is API-retrievable)
  //
  // So 3-D Secure is NOT the blocker — naming it sends the next engineer to the
  // wrong place, which has already cost this project several rounds. The blockers
  // are: there is no charge-by-reference endpoint, and the provider exposes card
  // VALUES, which ADR-0013 (as amended 2026-10-18) permits only via just-in-time
  // fetch into memory, never persisted.
  return {
    state: "requires_3ds",
    reference: null,
    card_id: card.id,
    amount: q.total,
    currency: card.currency,
    detail:
      "no charge-by-reference endpoint exists at 2fiat (POST prepaid-cards/pay " +
      "returns product_not_found); a charge needs the card VALUES, which " +
      "prepaid-cards/details/{id} supplies. ADR-0013 (2026-10-18 amendment) " +
      "permits a just-in-time fetch into memory only — the capture call is not " +
      "yet wired, so pay the venue directly for now",
  };
}

/** Re-read the card to corroborate a payment (balance moved?) — read-only. */
export async function statusFiat(
  client: FiatClient,
  cardId: string,
  expectedBalanceBelow?: number,
): Promise<{ card_id: string; balance: number; currency: string; corroborated: boolean | null }> {
  const cards = await client.cards();
  const card: Card | undefined = cards.find((c) => c.id === cardId);
  if (!card) throw new FiatError(`card ${cardId} is not in this wallet`);
  const corroborated = typeof expectedBalanceBelow === "number"
    ? card.balance < expectedBalanceBelow
    : null;
  return { card_id: card.id, balance: card.balance, currency: card.currency, corroborated };
}

/** MCP tool descriptors, shaped like the venue server's tool list. */
import { topupFiat, TOPUP_TOOL, type TopupInput } from "./topup.ts";
export { topupFiat, TOPUP_TOOL } from "./topup.ts";

export const FIAT_TOOLS = [
  {
    name: "cards",
    description:
      "List this wallet's cards and their balances. Read-only; returns masked numbers only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  TOPUP_TOOL as unknown as { name: string; description: string; inputSchema: Record<string, unknown> },
  {
    name: "quote",
    description:
      "Resolve which card would pay an amount and the fee-inclusive total. No side effect.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "Card to use; the richest is chosen when omitted." },
        amount: { type: "number", description: "The venue's charge in the card currency." },
      },
      required: ["amount"],
      additionalProperties: false,
    },
  },
  {
    name: "pay",
    description:
      "Attempt to pay a venue's charge from a card. May return a 3DS requirement; never claims success it did not observe.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        memo: { type: "string" },
        venue_slug: { type: "string" },
        venue_reference: { type: "string" },
      },
      required: ["amount"],
      additionalProperties: false,
    },
  },
  {
    name: "status",
    description: "Re-read a card to corroborate a payment. Read-only.",
    inputSchema: {
      type: "object",
      properties: { card_id: { type: "string" } },
      required: ["card_id"],
      additionalProperties: false,
    },
  },
] as const;

/** Dispatch a tool call. Unknown tools fail loud. */
export async function callFiatTool(
  client: FiatClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "cards":
      return { cards: await client.cards() };
    case "quote": {
      const cards = await client.cards();
      const card = client.pickCard(cards, args.card_id as string | undefined);
      return { card_id: card.id, ...client.quoteTotal(card, Number(args.amount)) };
    }
    case "pay":
      return await payFiat(client, args as unknown as PayInput);
    case "status":
      return await statusFiat(client, String(args.card_id));
    default:
      throw new FiatError(`unknown tool '${name}'`);
  }
}
