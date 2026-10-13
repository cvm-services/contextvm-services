/**
 * 2fiat.com client — the fiat leg of the facilitator flow (ADR-0016).
 *
 * Upstream quirks this module encodes, all MEASURED 2026-10-13:
 *
 *  1. The edge silently DROPS non-browser clients: a default curl User-Agent
 *     gets an empty reply / closed connection on every /api/v1 path, while a
 *     browser User-Agent gets a normal response. So every request carries a
 *     browser UA plus `ngrok-skip-browser-warning: 5000`.
 *  2. Auth is a session, not a bearer token: POST auth/exchange {token} sets a
 *     session cookie which must be carried on subsequent calls
 *     (`withCredentials: true` in the app).
 *  3. Money facts live in different places: the card balance comes from
 *     GET cards; the fee comes from the card product metadata (topup fee).
 *
 * The module NEVER reads, logs, or returns PAN/CVV. Only the masked number that
 * GET cards already provides is relayed.
 *
 * The wallet token is read from the environment (materialised from OpenBao at
 * runtime, ADR-020). It is never a parameter, never logged.
 */

export const DEFAULT_BASE_URL = "https://2fiat.com";

/** A browser-like UA is REQUIRED by the edge; the default curl UA is dropped. */
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export interface Card {
  id: string;
  masked_number: string;
  expiry: string;
  alias: string | null;
  payment_type: string;
  balance: number;
  currency: string;
  topup_fee: number | null;
}

export interface FiatOrder {
  reference: string;
  amount: number;
  currency: string;
  card_id: string;
  state: "captured" | "requires_3ds" | "declined";
  challenge_url?: string;
}

export class FiatError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FiatError";
  }
}

export interface FiatClientOptions {
  token: string;
  baseUrl?: string;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

interface RawCard {
  id?: string;
  balance?: number;
  currency?: string;
  cardNumber?: string;
  expirationDate?: string;
  alias?: string | null;
  paymentType?: string;
  cardProduct?: { metadata?: { topup_fee?: number } };
}

/** Normalise the upstream card record into the shape we expose. */
export function normaliseCard(raw: RawCard): Card {
  return {
    id: String(raw.id ?? ""),
    masked_number: String(raw.cardNumber ?? ""),
    expiry: String(raw.expirationDate ?? ""),
    alias: raw.alias ?? null,
    payment_type: String(raw.paymentType ?? ""),
    balance: typeof raw.balance === "number" ? raw.balance : 0,
    currency: String(raw.currency ?? "USD"),
    topup_fee: typeof raw.cardProduct?.metadata?.topup_fee === "number"
      ? raw.cardProduct.metadata.topup_fee
      : null,
  };
}

export class FiatClient {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(opts: FiatClientOptions) {
    if (!opts.token || !opts.token.trim()) {
      throw new FiatError("2fiat wallet token is required (from the OpenBao-materialised environment)");
    }
    this.#token = opts.token.trim();
    this.#base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  #headers(): HeadersInit {
    return {
      "content-type": "application/json",
      "accept": "application/json",
      // Both are required by the edge; without them the connection is dropped.
      "user-agent": BROWSER_UA,
      "ngrok-skip-browser-warning": "5000",
    };
  }

  /** Exchange the wallet login token for a session (the app's first call). */
  async login(nextPath = "/wallet/my-cards"): Promise<void> {
    const res = await this.#fetch(`${this.#base}/api/v1/auth/exchange`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ token: this.#token, nextPath }),
    });
    if (!res.ok) throw new FiatError("2fiat auth/exchange refused", res.status);
  }

  async cards(): Promise<Card[]> {
    const res = await this.#fetch(`${this.#base}/api/v1/cards`, { headers: this.#headers() });
    if (!res.ok) throw new FiatError("2fiat cards unavailable", res.status);
    const body = await res.json() as RawCard[] | { data?: RawCard[] };
    const rows = Array.isArray(body) ? body : (body.data ?? []);
    return rows.map(normaliseCard);
  }

  /** Pick a card by id, or the richest balance when no id is given. */
  pickCard(cards: Card[], cardId?: string): Card {
    if (cardId) {
      const found = cards.find((c) => c.id === cardId);
      if (!found) throw new FiatError(`card ${cardId} is not in this wallet`);
      return found;
    }
    if (cards.length === 0) throw new FiatError("this wallet has no cards");
    return [...cards].sort((a, b) => b.balance - a.balance)[0];
  }

  /** Fee-inclusive fiat total for an amount, using the card product's fee. */
  quoteTotal(card: Card, amount: number): { subtotal: number; fee: number; total: number } {
    if (!Number.isFinite(amount) || amount <= 0) throw new FiatError("amount must be positive");
    const feeRate = card.topup_fee ?? 0;
    const fee = Math.round(amount * feeRate * 100) / 100;
    return { subtotal: amount, fee, total: Math.round((amount + fee) * 100) / 100 };
  }
}
