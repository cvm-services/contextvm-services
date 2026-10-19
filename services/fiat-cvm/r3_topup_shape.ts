/**
 * Where is the BOLT11? Dump the topup response with values TRUNCATED but SHAPE
 * intact, so we can find the invoice without printing a payable string into a
 * transcript. Unpaid invoice: costs nothing.
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 25000 });
const cards = await client.cards();
const card = [...cards].sort((a,b)=>(b.balance??0)-(a.balance??0))[0];
const r = await client.requestTopup(card.id, { topupValue: "2", selectedMethod: "BTC-LN" });

function shape(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    if (/^lnbc/i.test(v)) return `[BOLT11 len=${v.length}]`;
    if (/^https?:/i.test(v)) return `[URL len=${v.length} host=${(new URL(v).host)}]`;
    return v.length > 40 ? `[str len=${v.length}] ${v.slice(0,8)}…` : v;
  }
  if (Array.isArray(v)) return v.slice(0, 4).map((x) => shape(x, depth+1));
  if (typeof v === "object" && depth < 4) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shape(val, depth+1);
    return o;
  }
  return v;
}
console.log(JSON.stringify(shape(r), null, 2));
