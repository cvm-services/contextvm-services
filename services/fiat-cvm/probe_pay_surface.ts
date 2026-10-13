/**
 * What can the 2fiat wallet actually DO with money? (read-only probe)
 *
 * `pay` in tools.ts is unwired because nothing has ever been OBSERVED that moves
 * money. This enumerates candidate endpoints and prints only the status code and
 * top-level response keys — no card numbers, no CVV, no tokens.
 *
 * GETs only. No POST is issued, so nothing here can move money.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     services/fiat-cvm/probe_pay_surface.ts
 */
import { FiatClient } from "./fiat_client.ts";
import { loadFiatSecret } from "./secret.ts";

// Capture the session cookie the client establishes, so the probe can reuse the
// client's exact login (and its edge-quirk headers) without duplicating them.
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
console.log("token source:", secret.source);
const client = new FiatClient({ token: secret.token, fetchImpl: capturingFetch });
await client.login().catch((e) => console.log("LOGIN FAILED:", String(e).slice(0, 140)));
console.log("session established:", client.sessionEstablished, cookie ? "(cookie captured)" : "(no cookie)");

const CANDIDATES = [
  "cards", "btc-currencies", "vccTransactions?skip=0&take=5",
  "payments", "transfers", "transactions", "orders", "payment-methods",
  "payment-orders", "checkout", "merchants", "beneficiaries", "recipients",
  "contacts", "wallets", "accounts", "card-transactions", "prepaid-cards",
  "topup", "topups", "deposits", "withdrawals", "payouts", "invoices",
  "webhooks", "user", "user/settings", "features", "config", "limits",
  "fees", "exchange",
];

const headers: Record<string, string> = {
  "content-type": "application/json",
  "accept": "application/json",
  "user-agent": UA,
  "ngrok-skip-browser-warning": "5000",
};
if (cookie) headers["cookie"] = cookie;

console.log("\nendpoint                                status  keys");
for (const path of CANDIDATES) {
  let out: string;
  try {
    const res = await fetch(`${BASE}/api/v1/${path}`, { headers });
    let keys = "";
    try {
      const body = await res.clone().json();
      keys = Array.isArray(body) ? `array[${body.length}]` : Object.keys(body ?? {}).slice(0, 7).join(",");
    } catch {
      keys = "(non-json)";
    }
    out = `${String(res.status).padEnd(4)}  ${keys}`;
    if (res.status === 200) out += "   <== EXISTS";
  } catch (e) {
    out = `ERR   ${String(e).slice(0, 50)}`;
  }
  console.log(`${path.padEnd(38)}  ${out}`);
}
