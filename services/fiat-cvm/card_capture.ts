// The card capture path — card values fetched JUST-IN-TIME, used, discarded.
//
// ADR-0013 (2026-10-18 amendment) permits card values so the card step can
// automate, but on narrow terms. This module is the ONLY place that materialises
// them, and it is written so the values cannot leak by construction:
//
//   * `cardValues()` returns a short-lived holder whose toString()/toJSON() are
//     redacted, so accidental interpolation or logging prints «redacted» rather
//     than the PAN.
//   * CVV is single-use: `consume()` clears every field and marks the holder dead,
//     so a second charge cannot reuse it.
//   * Nothing here writes to disk, and nothing puts a value in an error message.
//
// WHAT WE MEASURED (2026-10-18, $0 spent)
//   POST prepaid-cards/details/{id}      -> 200 {cardNumber, cvv, expirationDate}
//   GET  prepaid-cards/details/{id}/otp  -> 200 {} (or {otp:{code,...}} when pending)
//   POST prepaid-cards/pay               -> 404 product_not_found (NOT a charge)
// so a charge must be performed at the MERCHANT's checkout with these values.

import { FiatClient, FiatError } from "./fiat_client.ts";

/** Values as the provider returns them. NEVER log, serialise, or persist this. */
export interface CardValues {
  cardNumber: string;
  cvv: string;
  expirationDate: string;
}

/**
 * A holder that fights accidental disclosure. Printing it, JSON-encoding it, or
 * concatenating it into a string yields redaction, not the card.
 */
export class CardHandle {
  #values: CardValues | null;
  readonly cardId: string;
  readonly masked: string;

  constructor(cardId: string, masked: string, values: CardValues) {
    this.cardId = cardId;
    this.masked = masked;
    this.#values = values;
  }

  get alive(): boolean {
    return this.#values !== null;
  }

  /**
   * Run a charge with the values, then destroy them — always, including on throw.
   * The callback receives the values directly; the caller must not retain them.
   */
  async use<T>(fn: (v: CardValues) => Promise<T>): Promise<T> {
    const v = this.#values;
    if (!v) throw new FiatError("card values already consumed — fetch a fresh handle per charge");
    try {
      return await fn(v);
    } finally {
      this.consume();
    }
  }

  /** Destroy the values. Idempotent. */
  consume(): void {
    if (this.#values) {
      this.#values.cardNumber = "";
      this.#values.cvv = "";
      this.#values.expirationDate = "";
      this.#values = null;
    }
  }

  /** Deliberately useless for leaking: both of these redact. */
  toString(): string {
    return `CardHandle(${this.masked})`;
  }
  toJSON(): string {
    return `CardHandle(${this.masked})`;
  }
}

/**
 * Fetch card values for ONE charge. The caller MUST consume (or use()) the handle.
 * Values live in memory only; nothing is cached between charges.
 */
export async function cardValues(
  client: FiatClient,
  cardId: string,
  masked = "****",
): Promise<CardHandle> {
  const raw = await client.requestCardDetails(cardId);
  const cardNumber = String(raw.cardNumber ?? "");
  const cvv = String(raw.cvv ?? "");
  const expirationDate = String(raw.expirationDate ?? "");
  if (!cardNumber || !cvv) {
    throw new FiatError(
      `card ${masked}: provider returned incomplete values (cardNumber=${cardNumber ? "present" : "MISSING"}, ` +
        `cvv=${cvv ? "present" : "MISSING"})`,
    );
  }
  return new CardHandle(cardId, masked, { cardNumber, cvv, expirationDate });
}

/** A 3DS code as served by the provider. Never logged. */
export interface OtpChallenge {
  code: string;
  expiresAt?: string;
  merchantName?: string;
  amount?: string;
  currency?: string;
}

/** Read a pending OTP, or null when the merchant did not step up. */
export async function pendingOtp(
  client: FiatClient,
  cardId: string,
): Promise<OtpChallenge | null> {
  const raw = await client.requestOtp(cardId);
  const otp = (raw as { otp?: Record<string, unknown> }).otp;
  if (!otp || !otp.code) return null;
  return {
    code: String(otp.code),
    expiresAt: otp.expiresAt ? String(otp.expiresAt) : undefined,
    merchantName: otp.merchantName ? String(otp.merchantName) : undefined,
    amount: otp.amount ? String(otp.amount) : undefined,
    currency: otp.currency ? String(otp.currency) : undefined,
  };
}
