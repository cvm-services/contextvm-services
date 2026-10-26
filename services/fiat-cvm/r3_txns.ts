/** Read the provider's own card ledger — the authoritative record of charges. */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";

const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 30_000 });
const txs = await c.transactions(25);
console.log("count", txs.length);
for (const t of txs) {
  console.log(JSON.stringify({
    id: t.id.slice(0, 10), type: t.type, amount: t.amount,
    cur: t.currency, status: t.status, at: t.createdAt,
    desc: t.description.slice(0, 50),
  }));
}
