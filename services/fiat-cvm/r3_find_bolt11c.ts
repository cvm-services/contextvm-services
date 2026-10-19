import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 20000 });
const cards = await client.cards();
const card = [...cards].sort((a,b)=>(b.balance??0)-(a.balance??0))[0];
const inv = await client.requestTopup(card.id, { topupValue: "2", selectedMethod: "BTC-LN" }) as any;
const link = inv.checkoutLink || inv.redirectLink;
console.log("checkoutLink:", link);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const r = await fetch(link, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
const t = await r.text();
console.log("page status", r.status, "len", t.length, "bolt11_in_page:", /lnbc/i.test(t));
if (/lnbc/i.test(t)) { const m = t.match(/lnbc[a-z0-9]{50,}/i); console.log("BOLT11 len:", m?.[0].length); }
// Also try the public checkout API that the page itself would call.
for (const u of [
  link.replace(/\/$/,"") + "/invoice",
  link.replace(/\/$/,"") + "?format=json",
]) {
  try {
    const rr = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    const tt = await rr.text();
    console.log(rr.status, u.slice(-40), "len", tt.length, "bolt11", /lnbc/i.test(tt));
  } catch(e) { console.log("ERR", (e as Error).name); }
}
