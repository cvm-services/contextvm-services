/**
 * Fund one 2fiat card from the treasury — paying the invoice's OWN amount.
 *
 * Differs from `r3_fund_card.ts` in the one way that matters: the sats are
 * decoded from the BOLT11 the provider actually issued, never derived from a
 * hardcoded USD/sat rate. The old script assumed $0.00025820/sat (~BTC $25.8k);
 * the live rate is ~$80k, so it would have overpaid roughly 3x — the provider
 * quotes sats, and sats are what we pay.
 *
 * Safety order (deliberate, and unchanged from the reviewed script):
 *   1. treasury balance must cover the invoice + a margin
 *   2. journal the intent BEFORE paying
 *   3. pay once; a timeout is UNKNOWN, never retried (retry = double-pay)
 *   4. prove it by the CARD BALANCE, not by the wallet — an invoice paid is not
 *      a card funded
 *
 * Amount: 1.07 USD of sats. Smallest that proves the leg.
 */
import { NwcLnWallet } from "/data/repos/cvm-service-kit/src/lnwallet.ts";
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
import { topupFiat } from "./topup.ts";
import { bolt11Sats } from "./bolt11.ts";

const TOPUP_USD = 1;

const nwcUrl = Deno.env.get("NWC_URL") ?? "";
if (!nwcUrl) {
  console.error(JSON.stringify({ error: "no NWC_URL in env; refusing to continue" }));
  Deno.exit(2);
}

const wallet = new NwcLnWallet(nwcUrl, { timeoutMs: 90_000 });
const out: Record<string, unknown> = {};

// 1. headroom
const beforeSats = await wallet.balanceSats();
out.treasury_before_sats = beforeSats;

// 2. invoice
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 30_000 });
const cards0 = await client.cards();
const card0 = cards0[0];
out.card_before = { id: card0.id.slice(0, 8), masked: card0.masked_number, balance: card0.balance };

const inv = await topupFiat(client, { amount: TOPUP_USD, card_id: card0.id });
const sats = bolt11Sats(inv.bolt11);
out.invoice = {
  charged_usd: inv.chargedAmount,
  fee_usd: inv.fee,
  bolt11_len: inv.bolt11.length,
  decoded_sats: sats,
  implied_btc_usd: +(inv.chargedAmount / (sats / 1e8)).toFixed(0),
};

if (beforeSats < sats + 500) {
  console.error(JSON.stringify({ ...out, error: "treasury cannot cover the invoice" }));
  Deno.exit(3);
}

// ---- idempotency: refuse to pay twice for the same top-up -------------------
// Measured failure this prevents: running this script twice in quick succession
// buys two top-ups ($1 + $1) because each run mints a fresh invoice. The ledger
// is the only place that shows it, so consult it BEFORE spending.
const recent = await client.transactions(10);
const cutoff = Date.now() - 30 * 60 * 1000;
const recentTopups = recent.filter((t) =>
  /top ?up/i.test(t.description) &&
  t.status === "COMPLETED" &&
  Date.parse(t.createdAt) > cutoff
);
if (recentTopups.length > 0) {
  console.error(JSON.stringify({
    ...out,
    error: "a COMPLETED top-up already exists in the last 30 minutes — refusing to pay again",
    recent_topups: recentTopups.map((t) => ({ usd: t.amount, at: t.createdAt })),
    hint: "pass ALLOW_REPEAT=1 only when a second top-up is genuinely intended",
  }, null, 2));
  if (Deno.env.get("ALLOW_REPEAT") !== "1") Deno.exit(4);
}

console.log(JSON.stringify({ ...out, phase: "about_to_pay" }, null, 2));

// 3. journal BEFORE paying
const journal = `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;
let j: Record<string, unknown> = {};
try { j = JSON.parse(await Deno.readTextFile(journal)); } catch { /* first write */ }
const quotes = (j.quotes ?? []) as Record<string, unknown>[];
quotes.push({
  kind: "card_topup",
  card_id: card0.id,
  usd: inv.chargedAmount,
  sats,
  bolt11_len: inv.bolt11.length,
  created_at: new Date().toISOString(),
  state: "paying",
});
j.quotes = quotes;
await Deno.writeTextFile(journal, JSON.stringify(j, null, 2));

// 4. pay ONCE
try {
  const receipt = await wallet.payInvoice(inv.bolt11);
  out.preimage_present = Boolean(receipt?.preimage);
  out.pay = "ok";
} catch (e) {
  out.pay = "unknown";
  out.pay_error = `${(e as Error).name}: ${(e as Error).message}`;
  out.note = "outcome UNKNOWN — not retrying; polling the card balance instead";
}
console.log(JSON.stringify({ phase: "after_pay", ...out }, null, 2));

// 5. the ONLY proof
const polls: { t: string; balance: number }[] = [];
let funded = false;
for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const cs = await client.cards();
    const c = cs.find((x) => x.id === card0.id) ?? cs[0];
    polls.push({ t: `+${(i + 1) * 10}s`, balance: c.balance });
    if (c.balance > card0.balance + 0.5) { funded = true; break; }
  } catch {
    polls.push({ t: `+${(i + 1) * 10}s`, balance: -1 });
  }
}

const afterSats = await wallet.balanceSats().catch(() => null);
console.log(JSON.stringify({
  phase: "verdict",
  funded,
  card_polls: polls,
  treasury_after_sats: afterSats,
  sats_spent: afterSats !== null ? beforeSats - afterSats : null,
  verdict: funded
    ? `CARD FUNDED from ${card0.balance} to ${polls.at(-1)?.balance}`
    : "NOT VERIFIED — the card balance did not move; treat the payment as unresolved",
}, null, 2));
