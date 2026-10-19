import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 20000 });
const cards = await client.cards();
const card = [...cards].sort((a,b)=>(b.balance??0)-(a.balance??0))[0];
const inv = await client.requestTopup(card.id, { topupValue: "2", selectedMethod: "BTC-LN" }) as any;
console.log("id:", inv.id, "storeId:", String(inv.storeId).slice(0,10)+"…");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const H = { "authorization": `Bearer ${secret.token}`, "user-agent": UA, "ngrok-skip-browser-warning": "5000" };
const base = "https://2fiat.com/api/v1";
const tries = [
  `${base}/stores/${inv.storeId}/invoices/${inv.id}`,
  `${base}/stores/${inv.storeId}/invoices/${inv.id}/payment-methods`,
  `${base}/stores/${inv.storeId}/payment-methods/${inv.id}`,
];
for (const u of tries) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    console.log(`${r.status} ${u.replace(base,"").replace(inv.storeId,"<store>")} len=${t.length} bolt11=${/lnbc/i.test(t)}`);
    if (/lnbc/i.test(t)) {
      const m = t.match(/lnbc[a-z0-9]{50,}/i);
      console.log("  BOLT11 len:", m?.[0].length);
    } else if (r.status < 400 && t.length < 500) console.log("  ", t.slice(0,400));
  } catch(e) { console.log("ERR", (e as Error).name); }
}
