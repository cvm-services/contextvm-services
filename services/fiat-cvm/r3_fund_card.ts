/**
 * FUND ONE CARD, FOR REAL — and prove it by the CARD BALANCE, not by the wallet.
 *
 * Operator-approved spend (~2.13 USD of sats). This is the one script that moves
 * money in this sequence, so it journals BEFORE paying and never retries a
 * payment whose outcome is unknown (retry = double-pay).
 *
 * Order of operations (deliberate):
 *   1. read treasury balance (must cover the invoice)
 *   2. create the topup invoice        (unpaid, costs nothing)
 *   3. print the plan + the exact sats, THEN pay
 *   4. pay_invoice                     (broker executes; it stays silent)
 *   5. poll the MINT-side reality the only way available: the 2fiat CARD BALANCE.
 *      An invoice paid is not a card funded. Only the balance proves it.
 *
 * Amount is deliberately the smallest that proves the leg: the provider quoted
 * 2.13 for a $2 top-up (fee 6.5%). Do NOT round up.
 */
import { NwcLnWallet } from "/data/repos/cvm-service-kit/src/lnwallet.ts";
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
import { topupFiat } from "./topup.ts";
import { bolt11Sats } from "./bolt11.ts";

const TOPUP_USD = 2;
const CARD_ID = "1ca031655b5d4c74a35e090b7979f7df"; // ailaptop-not-doxed, 0.38

const nwcUrl = Deno.env.get("NWC_URL") ??
  (await Deno.readTextFile(`${Deno.env.get("HOME")}/.hermes/secrets/nwc-cvm-orders.env`))
    .split("\n").map((l) => l.trim().replace(/^export\s+/, ""))
    .find((l) => l.startsWith("NWC_URL="))?.slice("NWC_URL=".length).replace(/^["']|["']$/g, "") ?? "";

if (!nwcUrl) {
  console.error(JSON.stringify({ error: "no NWC_URL in env or secrets file" }));
  Deno.exit(2);
}

const out: Record<string, unknown> = {};
const wallet = new NwcLnWallet(nwcUrl, { timeoutMs: 90_000 });

// ---- 1. treasury headroom ---------------------------------------------------
const beforeSats = await wallet.balanceSats();
out.treasury_before_sats = beforeSats;

// ---- 2. the invoice --------------------------------------------------------
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 30_000 });

const cards0 = await client.cards();
const card0 = cards0.find((c) => c.id === CARD_ID) ?? cards0[0];
out.card_before = { id: card0.id, masked: card0.masked_number, balance: card0.balance };

const inv = await topupFiat(client, { amount: TOPUP_USD, card_id: card0.id });
// NEVER derive sats from a price. This line used to read
//   const sats = Math.ceil(inv.chargedAmount / 0.00025820);
// i.e. it assumed BTC ~= $25,820 and would have paid 4,145 sats for a 1,334-sat
// invoice (BTC ~= $80,210) - a 3.1x overpay, every time. The invoice states its
// own amount; decode it.
const sats = bolt11Sats(inv.bolt11);
out.invoice = {
  charged_usd: inv.chargedAmount,
  subtotal_usd: inv.subtotal,
  fee_usd: inv.fee,
  approx_sats: sats,
  bolt11_len: inv.bolt11.length,
};

if (beforeSats < sats + 200) {
  console.error(JSON.stringify({ ...out, error: "treasury cannot cover the invoice" }));
  Deno.exit(3);
}

console.log(JSON.stringify({ ...out, phase: "about_to_pay" }, null, 2));

// ---- 3. journal BEFORE paying ---------------------------------------------
const journal = `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;
let j: Record<string, unknown> = {};
try {
  j = JSON.parse(await Deno.readTextFile(journal));
} catch { /* first write */ }
const quotes = (j.quotes ?? []) as Record<string, unknown>[];
quotes.push({
  kind: "card_topup",
  card_id: card0.id,
  usd: inv.chargedAmount,
  bolt11_len: inv.bolt11.length,
  created_at: new Date().toISOString(),
  state: "paying",
});
j.quotes = quotes;
await Deno.writeTextFile(journal, JSON.stringify(j, null, 2));

// ---- 4. pay --------------------------------------------------------------
let payError: string | null = null;
try {
  const receipt = await wallet.payInvoice(inv.bolt11);
  out.preimage_present = Boolean(receipt?.preimage);
} catch (e) {
  payError = `${(e as Error).name}: ${(e as Error).message}`;
  out.pay_error = payError;
  // A timeout is NOT a failure — the broker may have paid. Never retry here.
  out.note = "outcome unknown — do NOT retry; polling the card balance instead";
}

// ---- 5. the ONLY proof: the card balance ---------------------------------
const polls: { t: string; balance: number }[] = [];
let funded = false;
for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const cs = await client.cards();
    const c = cs.find((x) => x.id === card0.id) ?? cs[0];
    polls.push({ t: `+${(i + 1) * 10}s`, balance: c.balance });
    if (c.balance > card0.balance + 0.5) {
      funded = true;
      break;
    }
  } catch (e) {
    polls.push({ t: `+${(i + 1) * 10}s`, balance: -1 });
  }
}

const afterSats = await wallet.balanceSats().catch(() => null);
out.treasury_after_sats = afterSats;
out.sats_spent = afterSats !== null ? beforeSats - afterSats : null;
out.card_polls = polls;
out.FUNDED = funded;
console.log(JSON.stringify(out, null, 2));
