/**
 * Write the card values to a 0600 file for the Playwright driver, JIT from 2fiat.
 * Values are NEVER printed; only a shape summary is logged.
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";

const CARD_ID = "1ca031655b5d4c74a35e090b7979f7df";
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 25000 });
const d = await c.requestCardDetails(CARD_ID);

const pan = String(d.cardNumber ?? "").replace(/\s+/g, "");
const exp = String(d.expirationDate ?? "");
const cvc = String(d.cvv ?? "");
if (!/^\d{15,19}$/.test(pan) || !/^\d{3,4}$/.test(cvc) || !exp) {
  console.error(JSON.stringify({error: "incomplete card details"}));
  Deno.exit(2);
}
// expiry may be MM/YY or MM/YYYY; Stripe accepts MM/YY (and MMYY)
let e = exp.replace(/[^0-9]/g, "");
if (e.length === 6) e = e.slice(0, 2) + "/" + e.slice(4, 6);
else if (e.length === 4) e = e.slice(0, 2) + "/" + e.slice(2, 4);

await Deno.remove("/tmp/r3_cv.json").catch(() => {});
await Deno.writeTextFile("/tmp/r3_cv.json", JSON.stringify({ pan, exp: e, cvc }), { mode: 0o600 });
console.log(JSON.stringify({
  ok: true, pan_len: pan.length, exp_shape: e.length, cvc_len: cvc.length,
  luhn: (() => { let s=0,d=false; for (let i=pan.length-1;i>=0;i--){let n=+pan[i]; if(d){n*=2; if(n>9)n-=9;} s+=n; d=!d;} return s%10===0; })(),
}));
