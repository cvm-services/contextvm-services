/**
 * Fetch the pending 3DS OTP for the funded card. Prints ONLY:
 *   {"code": "...", "merchant": "...", "amount": ...}
 * — the code is a short-lived single-use challenge answer, not a credential, and it
 * must reach the payment session. Nothing else is logged.
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const CARD_ID = "1ca031655b5d4c74a35e090b7979f7df";
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 25000 });
const o = await c.requestOtp(CARD_ID);
if (o && (o as any).otp) {
  const x = (o as any).otp;
  console.log(JSON.stringify({ code: String(x.code ?? ""), merchant: x.merchantName ?? null,
                               amount: x.amount ?? null, currency: x.currency ?? null }));
} else {
  console.log(JSON.stringify({ code: null, note: "no pending otp" }));
}
