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
  return {
    state: "requires_3ds",
    reference: null,
    card_id: card.id,
    amount: q.total,
    currency: card.currency,
    detail:
      "card capture is 3D-Secure-gated upstream and the capture call is not " +
      "yet wired; pay the venue directly or approve in the wallet UI",
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
export const FIAT_TOOLS = [
  {
    name: "cards",
    description:
      "List this wallet's cards and their balances. Read-only; returns masked numbers only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
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
