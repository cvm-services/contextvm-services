/**
 * Test the 2fiat leg WITHOUT paying anything.
 *
 * Creates a real top-up invoice (an unpaid invoice costs nothing and expires) and
 * reports its shape. This proves, live and end to end:
 *   OpenBao AppRole -> token -> 2fiat auth -> card list -> topup -> BOLT11 + fee
 *
 * ADR-0013: the token is resolved in-process by loadFiatSecret (OpenBao) and is
 * never printed, never on argv, never logged. A BOLT11 is a payment REQUEST
 * (public by design), not a credential — and it is reported truncated.
 *
 *   deno run --allow-net --allow-read --allow-env services/fiat-cvm/r3_topup_probe.ts [amount]
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";

const amount = Deno.args[0] ?? "2";
const out: Record<string, unknown> = {};

const secret = await loadFiatSecret();
out.secret_source = secret.source;
out.token_len = secret.token.length;

// 2fiat's base URL is a constant on the client; construct with the token only.
const client = new FiatClient({ token: secret.token, timeoutMs: 25000 });

const cards = await client.cards();
out.cards = cards.map((c) => ({
  id: c.id.slice(0, 8) + "…",
  masked: c.masked_number,
  balance: c.balance,
  currency: c.currency,
  topup_fee: c.topup_fee,
}));
if (!cards.length) {
  console.log(JSON.stringify({ ...out, error: "no cards on this account" }, null, 2));
  Deno.exit(1);
}

// Prefer the card with the MOST headroom so the eventual spend test is realistic.
const card = [...cards].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))[0];
out.using_card = { id: card.id.slice(0, 8) + "…", balance: card.balance };

// Request a top-up invoice. NOT PAID: an unpaid invoice expires, costs nothing.
const r = await client.requestTopup(card.id, {
  topupValue: amount,
  selectedMethod: "BTC-LN",
});
out.topup_raw = {
  amount: r.amount ?? null,
  checkoutLink_present: Boolean(r.checkoutLink),
  checkoutLink_prefix: r.checkoutLink
    ? r.checkoutLink.slice(0, 14) + "…"
    : null,
  checkoutLink_looks_bolt11: r.checkoutLink
    ? /^lnbc/i.test(r.checkoutLink)
    : null,
  checkoutLink_len: r.checkoutLink ? r.checkoutLink.length : 0,
  other_keys: Object.keys(r).filter(
    (k) => !["amount", "checkoutLink", "checkout"].includes(k),
  ),
};

console.log(JSON.stringify(out, null, 2));
