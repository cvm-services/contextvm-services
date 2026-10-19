/**
 * Locate the BOLT11 for an existing 2fiat top-up invoice (BTCPay-style).
 * Unpaid -> costs nothing. Prints only the SHAPE (BOLT11 shown as [BOLT11 len=N]).
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 20000 });
const cards = await client.cards();
const card = [...cards].sort((a,b)=>(b.balance??0)-(a.balance??0))[0];
const inv = await client.requestTopup(card.id, { topupValue: "2", selectedMethod: "BTC-LN" });
const id = (inv as any).id;
console.log("invoice id:", id);

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const base = "https://2fiat.com/api/v1";
const tries = [
  `${base}/invoices/${id}`,
  `${base}/invoices/${id}/payment-methods`,
  `${base}/checkout/${id}`,
  `${base}/prepaid-cards/topup/${id}`,
];
for (const u of tries) {
  try {
    const r = await fetch(u, { headers: { "authorization": `Bearer ${secret.token}`,
      "user-agent": UA, "ngrok-skip-browser-warning": "5000" },
      signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    const hasBolt11 = /lnbc/i.test(t);
    console.log(`${r.status} ${u.replace(base,"")} len=${t.length} bolt11=${hasBolt11}`);
    if (hasBolt11) {
      const m = t.match(/lnbc[a-z0-9]{50,}/i);
      console.log("  BOLT11 found, len:", m ? m[0].length : "?");
    } else if (r.status < 400 && t.length < 400) {
      console.log("  body:", t.slice(0, 300));
    }
  } catch (e) {
    console.log("ERR", u.replace(base,""), (e as Error).name);
  }
}
