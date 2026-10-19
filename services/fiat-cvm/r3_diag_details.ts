import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const CARD_ID = "1ca031655b5d4c74a35e090b7979f7df";
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 25000 });
const cs = await c.cards();
console.log("cards:", JSON.stringify(cs.map(x=>({id:x.id.slice(0,8), bal:x.balance, masked:x.masked_number}))));
try {
  const d = await c.requestCardDetails(CARD_ID);
  console.log("details keys:", Object.keys(d));
  console.log("pan_present:", Boolean(d.cardNumber), "cvv_present:", Boolean(d.cvv), "exp_present:", Boolean(d.expirationDate));
} catch (e) {
  console.log("DETAILS ERROR:", (e as Error).message);
  // probe the raw status
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
  try {
    const r = await fetch(`https://2fiat.com/api/v1/prepaid-cards/details/${CARD_ID}`, {
      method: "POST",
      headers: { "authorization": `Bearer ${s.token}`, "content-type": "application/json",
                 "user-agent": UA, "ngrok-skip-browser-warning": "5000" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
    console.log("raw status:", r.status);
    console.log("raw body:", (await r.text()).slice(0, 300));
  } catch (e2) { console.log("raw threw:", (e2 as Error).name); }
}
