import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const CARD_ID = "1ca031655b5d4c74a35e090b7979f7df";
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 25000 });
// warm the session the way the client does, then repeat details a few times to see
// whether this is a SCOPE problem (always 401) or a RACE/FLAKE (intermittent).
await c.cards();
const codes = [];
for (let i = 0; i < 3; i++) {
  try { const d = await c.requestCardDetails(CARD_ID); codes.push(`200(${Object.keys(d).length} keys)`); }
  catch (e) { codes.push((e as Error).message.slice(-24)); }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("details attempts:", JSON.stringify(codes));
// compare with an endpoint that succeeded before
try { const q = await c.requestTopup(CARD_ID, { topupValue: "2", selectedMethod: "BTC-LN" }); console.log("topup: ok amount", (q as any).amount); }
catch (e) { console.log("topup:", (e as Error).message.slice(0, 80)); }
