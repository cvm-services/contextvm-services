/**
 * The ONE place a BOLT11 amount is read.
 *
 * WHY THIS MODULE EXISTS
 *   A card top-up was nearly overpaid 3.1x because a script converted USD to sats
 *   with a hardcoded rate (`0.00025820 USD/sat`, i.e. BTC ~= $25,820) while the
 *   provider actually quotes sats: a $1.07 invoice is `lnbc13340n` = 1,334 sats,
 *   i.e. BTC ~= $80,210. That formula paid 4,145 sats for a 1,334-sat invoice.
 *
 *   An invoice states its own amount. Paying it needs no price feed, no rate
 *   constant and no configuration — so the amount must be DECODED from the
 *   invoice, never derived from a price.
 *
 *   Two scripts had divergent copies of this logic; one of them still had the
 *   bug. Shared here so a future edit cannot fix one and leave the other paying
 *   three times the bill.
 */

const MULTIPLIERS: Record<string, number> = {
  m: 1e-3, // milli-bitcoin
  u: 1e-6, // micro-bitcoin
  n: 1e-9, // nano-bitcoin
  p: 1e-12, // pico-bitcoin
  "": 1,
};

/**
 * Decode the payable amount from a BOLT11 invoice prefix.
 *
 * Accepts `lnbc<digits><multiplier>1...` (mainnet). Throws on anything it cannot
 * read rather than returning a guess: a wrong number here spends real money, so
 * "I don't know" must be an error, never a default.
 *
 * Amountless invoices have no digits and cannot be turned into a number — that is
 * also an error, because every caller here pays a FIXED invoice.
 */
export function bolt11Sats(bolt11: string): number {
  const inv = bolt11.trim().toLowerCase();
  const m = /^lnbc(\d+)([munp]?)1/.exec(inv);
  if (!m) {
    // Do NOT try to tell "amountless" from "malformed": after the currency, a
    // leading digit can be the amount OR the '1' separator, so the two are
    // grammatically ambiguous without a full parser. Every caller here pays a
    // FIXED invoice, so one honest refusal covers both and cannot guess an
    // amount.
    throw new Error(
      "not a fixed-amount mainnet BOLT11 (expected lnbc<digits><m|u|n|p>1...)",
    );
  }
  const digits = Number(m[1]);
  const sats = Math.round(digits * MULTIPLIERS[m[2]] * 1e8);
  if (!Number.isFinite(sats) || sats <= 0) {
    throw new Error(`unreadable BOLT11 amount: ${m[1]}${m[2]}`);
  }
  return sats;
}
