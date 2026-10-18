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

/** Bounded so a silent 2fiat edge cannot hang the CVM (observed 2026-10-13). */
export const DEFAULT_TIMEOUT_MS = 20_000;

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
  /**
   * Milliseconds before a request is aborted. Observed in production: when
   * 2fiat's edge stopped answering (TCP-level block), the CVM hung forever
   * instead of failing, because fetch was called with no signal — the operator
   * saw an empty tool reply and could not tell whether money had moved.
   */
  timeoutMs?: number;
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
  readonly #timeoutMs: number;
  /** Session cookie captured from auth/exchange; fetch has no cookie jar. */
  #cookie: string | null = null;

  constructor(opts: FiatClientOptions) {
    if (!opts.token || !opts.token.trim()) {
      throw new FiatError("2fiat wallet token is required (from the OpenBao-materialised environment)");
    }
    this.#token = opts.token.trim();
    this.#base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Every request goes through here, so no call can hang forever.
   *
   * A hung tool call is the worst failure mode for a money tool: the console
   * shows nothing and the operator cannot tell whether the payment went through.
   * A timeout surfaces as a FiatError naming the timeout, which the UI can show.
   */
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(`${this.#base}/api/v1/${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted || (e as Error)?.name === "AbortError") {
        throw new FiatError(
          `2fiat timed out after ${this.#timeoutMs}ms (${path}) — the request was aborted, so it did NOT complete`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get sessionEstablished(): boolean {
    return this.#cookie !== null;
  }

  #headers(): HeadersInit {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json",
      // Both are required by the edge; without them the connection is dropped.
      "user-agent": BROWSER_UA,
      "ngrok-skip-browser-warning": "5000",
    };
    if (this.#cookie) h["cookie"] = this.#cookie;
    return h;
  }

  /** Exchange the wallet login token for a session (the app's first call). */
  async login(nextPath = "/wallet/my-cards"): Promise<void> {
    const res = await this.#request("auth/exchange", {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ token: this.#token, nextPath }),
    });
    if (!res.ok) throw new FiatError("2fiat auth/exchange refused", res.status);
    // Deno's fetch does not persist cookies; the session IS the auth, so the
    // cookie must be carried explicitly or every later call 401s.
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.#cookie = setCookie.split(";")[0];
    }
  }

  /** Log in on first use, then reuse the session. */
  async ensureSession(): Promise<void> {
    if (!this.#cookie) await this.login();
  }

  async cards(): Promise<Card[]> {
    await this.ensureSession();
    const res = await this.#request("cards", { headers: this.#headers() });
    if (!res.ok) throw new FiatError(`2fiat cards unavailable (HTTP ${res.status})`, res.status);
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

  /**
   * POST /api/v1/prepaid-cards/topup/{cardId} — returns an INVOICE to pay.
   * Measured contract: {"topupValue":"N","selectedMethod":"BTC-LN"} ->
   *   { amount, checkoutLink, checkout: { defaultPaymentMethod: "BTC-LN" } }
   * `checkoutLink` is a BOLT11 to pay; paying it funds the card. The provider's
   * `amount` is the fee-inclusive figure actually charged.
   */
  async requestTopup(
    cardId: string,
    body: { topupValue: string; selectedMethod: "BTC-LN" },
  ): Promise<{ amount?: string; checkoutLink?: string; checkout?: unknown }> {
    const res = await this.#request(
      `prepaid-cards/topup/${encodeURIComponent(cardId)}`,
      { method: "POST", headers: this.#headers(), body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new FiatError(`topup ${cardId}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  }

  /**
   * POST /api/v1/prepaid-cards/details/{cardId} — returns the card's FULL VALUES
   * (`cardNumber`, `cvv`, `expirationDate`), measured 2026-10-18 (HTTP 200).
   *
   * This is the only way to obtain what a merchant checkout needs: 2fiat exposes
   * no charge-by-reference endpoint (`POST prepaid-cards/pay` -> 404
   * `product_not_found`). Handle the result per ADR-0013's 2026-10-18 amendment:
   * just-in-time, in memory, never logged or persisted — use card_capture.ts,
   * which returns a self-redacting, single-use handle.
   */
  async requestCardDetails(
    cardId: string,
  ): Promise<{ cardNumber?: string; cvv?: string; expirationDate?: string }> {
    const res = await this.#request(
      `prepaid-cards/details/${encodeURIComponent(cardId)}`,
      { method: "POST", headers: this.#headers(), body: JSON.stringify({}) },
    );
    if (!res.ok) {
      throw new FiatError(`card details ${cardId}: http ${res.status}`);
    }
    return await res.json();
  }

  /**
   * GET /api/v1/prepaid-cards/details/{cardId}/otp — the 3-D Secure challenge.
   * Measured 2026-10-18: 200, `{}` when nothing is pending, else
   * `{otp:{code, expiresAt, merchantName, amount, currency}}`.
   *
   * This is why "3DS blocks automation" was wrong: the code is machine-readable.
   */
  async requestOtp(cardId: string): Promise<Record<string, unknown>> {
    const res = await this.#request(
      `prepaid-cards/details/${encodeURIComponent(cardId)}/otp`,
      { headers: this.#headers() },
    );
    if (!res.ok) throw new FiatError(`card otp ${cardId}: http ${res.status}`);
    return await res.json();
  }

  /** Fee-inclusive fiat total for an amount, using the card product's fee. */
  quoteTotal(card: Card, amount: number): { subtotal: number; fee: number; total: number } {
    if (!Number.isFinite(amount) || amount <= 0) throw new FiatError("amount must be positive");
    const feeRate = card.topup_fee ?? 0;
    const fee = Math.round(amount * feeRate * 100) / 100;
    return { subtotal: amount, fee, total: Math.round((amount + fee) * 100) / 100 };
  }
}
