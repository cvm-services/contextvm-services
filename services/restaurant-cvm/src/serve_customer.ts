/**
 * Listener for the customer API. The handler is pure; this is the adapter the
 * systemd unit starts and Caddy proxies to.
 *
 * Env (never literals, never argv):
 *   CVM_CUSTOMER_PORT     default 8793, LOOPBACK ONLY
 *   CVM_MENU_FILE         menu json (default ../venues/three-buddies/menu.json)
 *   CVM_RAIL_URL          the settlement rail endpoint
 *   CVM_RAIL_PURPOSE      ok | ecash_mechanics | test   (default ok = payment)
 *   NWC_URL               required for real payments, loaded by src/secret.ts
 *
 * THE GUARD RUNS BEFORE THE LISTENER STARTS. A service that boots against a fake
 * mint and accepts payments is worse than one that refuses to boot, because the
 * failure would be silent and financial.
 */
import { Settlement, type InvoiceIssuer, type Provider } from "./settlement.ts";
import { createCustomerApi, type MenuItem } from "./customer_api.ts";
import { assertRailAllowed, isEvidenceBearing, type RailPurpose } from "./rail_guard.ts";
import { loadSecret } from "./secret.ts";

const PORT = Number(Deno.env.get("CVM_CUSTOMER_PORT") ?? "8793");
const RAIL_URL = Deno.env.get("CVM_RAIL_URL") ?? "";
const RAIL_PURPOSE = (Deno.env.get("CVM_RAIL_PURPOSE") ?? "ok") as RailPurpose | "ok";

const purpose: RailPurpose = RAIL_PURPOSE === "ok" ? "payment" : RAIL_PURPOSE;

// Refuse to start rather than accept money on a rail that cannot honour it.
try {
  assertRailAllowed(RAIL_URL, purpose);
} catch (e) {
  console.error(JSON.stringify({
    fatal: "rail_refused",
    detail: String((e as Error)?.message ?? e),
    rail_url_host: (() => { try { return new URL(RAIL_URL).hostname; } catch { return "(none)"; } })(),
  }));
  Deno.exit(2);
}

const menuPath = Deno.env.get("CVM_MENU_FILE") ?? new URL("../venues/three-buddies/menu.json", import.meta.url).pathname;
const menuDoc = JSON.parse(await Deno.readTextFile(menuPath));
// The generated menu file wraps items with its rate provenance; accept either
// shape so a hand-written array also works.
const menu = (Array.isArray(menuDoc) ? menuDoc : menuDoc.items) as MenuItem[];
if (!Array.isArray(menu) || menu.length === 0) {
  console.error(JSON.stringify({ fatal: "empty_menu", path: menuPath }));
  Deno.exit(4);
}

// ---- rails ---------------------------------------------------------------
// The real implementations live with the fiat adapter; this file only wires them
// and must not contain pricing or payment logic of its own.
let nwcUrl = "";
try {
  nwcUrl = (await loadSecret({ name: "nwc_url", allowFileFallback: purpose !== "payment" })).value;
} catch (e) {
  // A missing credential is a startup failure, not a runtime surprise three
  // layers away. Fail here, in one line an operator can act on.
  console.error(JSON.stringify({
    fatal: "missing_secret",
    detail: String((e as Error)?.message ?? e),
    hint: "set CVM_ORDER_NWC_URL, grant fleet-node-x280 on secret/data/fleet/food-order, or provide the 0600 fallback",
  }));
  Deno.exit(3);
}

const provider: Provider = {
  async pay() {
    // Deliberately not implemented in this file: the rail adapter owns payment.
    // Failing loudly beats returning a status we did not observe.
    throw new Error("rail adapter not wired: refusing to claim an outcome we did not observe");
  },
  async lookup() {
    throw new Error("rail adapter not wired: refusing to answer without the rail");
  },
};

const issuer: InvoiceIssuer = {
  async issue(sats) {
    throw new Error(`invoice issuance not wired (would issue ${sats} sats)`);
  },
};

const settlement = new Settlement(provider, issuer);
const handler = createCustomerApi({ menu, settlement });

console.log(JSON.stringify({
  listening: PORT,
  menu_items: menu.length,
  rail_evidence_bearing: isEvidenceBearing(RAIL_URL),
  nwc_configured: Boolean(nwcUrl),
  note: "rails are wired but their adapter is not; invoice and pay will fail loudly until it is",
}));

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handler);
