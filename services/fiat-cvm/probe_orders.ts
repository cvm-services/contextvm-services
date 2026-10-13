/**
 * Follow-up probe: what ARE the orders / transactions, and can anything move
 * money? Prints only types, statuses and amounts — never PAN/CVV/tokens.
 */
import { FiatClient } from "./fiat_client.ts";
import { loadFiatSecret } from "./secret.ts";

let cookie: string | null = null;
const BASE = "https://2fiat.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const capturingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
};

const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, fetchImpl: capturingFetch });
await client.login();

const H: Record<string, string> = {
  "content-type": "application/json",
  "accept": "application/json",
  "user-agent": UA,
  "ngrok-skip-browser-warning": "5000",
};
if (cookie) H["cookie"] = cookie;

async function get(path: string) {
  const res = await fetch(`${BASE}/api/v1/${path}`, { headers: H });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}

console.log("=== GET orders (no params) ===");
console.log(JSON.stringify(await get("orders")).slice(0, 400));

console.log("\n=== GET orders with likely params ===");
for (const q of ["orders?skip=0&take=5", "orders?cardId=" + "", "orders?status=", "orders?type=payment"]) {
  const r = await get(q);
  console.log(q, "->", r.status, JSON.stringify(r.body).slice(0, 200));
}

console.log("\n=== transactions: what kinds exist? ===");
const tx = await get("transactions?skip=0&take=70");
const rows = Array.isArray(tx.body) ? (tx.body as Record<string, unknown>[]) : [];
const types = new Map<string, number>();
for (const r of rows) {
  const k = String(r.type ?? r.transactionType ?? "?") + " / " + String(r.status ?? "?");
  types.set(k, (types.get(k) ?? 0) + 1);
}
for (const [k, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${k}`);
console.log("  sample row keys:", rows[0] ? Object.keys(rows[0]).join(",") : "(none)");

console.log("\n=== vccTransactions types ===");
const v = await get("vccTransactions?skip=0&take=20");
const vrows = (v.body as { data?: Record<string, unknown>[] })?.data ?? [];
const vt = new Map<string, number>();
for (const r of vrows) {
  const k = String(r.type ?? "?") + " / " + String(r.status ?? "?");
  vt.set(k, (vt.get(k) ?? 0) + 1);
}
for (const [k, n] of vt) console.log(`  ${n.toString().padStart(3)}  ${k}`);
console.log("  totalCount:", (v.body as { totalCount?: number })?.totalCount);

console.log("\n=== invoices / prepaid-cards ===");
console.log("invoices ->", JSON.stringify(await get("invoices")).slice(0, 200));
const pc = await get("prepaid-cards");
const pcs = Array.isArray(pc.body) ? (pc.body as Record<string, unknown>[])[0] : null;
console.log("prepaid-cards[0] keys:", pcs ? Object.keys(pcs).join(",") : "(none)");
