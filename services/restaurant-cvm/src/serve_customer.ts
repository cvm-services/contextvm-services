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
import { buildRail, readRailConfig } from "./rail_wiring.ts";
import { FiatClient } from "../../fiat-cvm/fiat_client.ts";
import { readListenHost } from "./listen.ts";

const PORT = Number(Deno.env.get("CVM_CUSTOMER_PORT") ?? "8793");
const HOST = readListenHost((n) => Deno.env.get(n));
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

// USD per order, recorded at creation. The rail needs it to size the card top-up,
// and the price the CUSTOMER pays comes back from 2fiat's invoice, not from here.
const usdByOrder = new Map<string, number>();

let railCfg;
try {
  railCfg = readRailConfig((n) => Deno.env.get(n));
} catch (e) {
  // An unexplained FX factor is an unauditable price; refuse to start rather than
  // price an order with a number nobody can trace.
  console.error(JSON.stringify({
    fatal: "rail_config",
    detail: String((e as Error)?.message ?? e),
    need: ["CVM_USD_PER_EUR", "CVM_USD_PER_EUR_SOURCE", "CVM_RAIL_CARD_ID"],
  }));
  Deno.exit(4);
}
let twoFiatToken = "";
try {
  twoFiatToken = (await loadSecret({ name: "two_fiat_token", allowFileFallback: purpose !== "payment" })).value;
} catch (e) {
  console.error(JSON.stringify({
    fatal: "missing_secret",
    detail: String((e as Error)?.message ?? e),
    hint: "set CVM_ORDER_TWO_FIAT_TOKEN, grant fleet-node-x280 on the vault path, or provide the 0600 fallback",
  }));
  Deno.exit(3);
}

const fiatClient = new FiatClient({ token: twoFiatToken, timeoutMs: 30_000 });

// The NWC wallet lives in the service kit, which is a SEPARATE repo with its own
// dependency tree. Hard-importing it here would bake this host's layout into the
// service; the path is configuration, and a missing wallet fails loudly.
const kitPath = Deno.env.get("CVM_KIT_WALLET") ?? "../../cvm-service-kit/src/lnwallet.ts";
let wallet: unknown;
try {
  const mod = await import(new URL(kitPath, import.meta.url).href) as {
    NwcLnWallet: new (url: string, opts?: { timeoutMs?: number }) => unknown;
  };
  wallet = new mod.NwcLnWallet(nwcUrl, { timeoutMs: 90_000 });
} catch (e) {
  console.error(JSON.stringify({
    fatal: "wallet_unavailable",
    tried: kitPath,
    detail: String((e as Error)?.message ?? e).slice(0, 160),
    hint: "set CVM_KIT_WALLET to the NWC wallet module, or install the kit next to this service",
  }));
  Deno.exit(5);
}

const rail = buildRail({
  client: fiatClient as never,
  wallet: wallet as never, // structurally a LnWalletLike; shape checked by the adapter
  config: railCfg,
  usdPerOrder: (orderId) => {
    const usd = usdByOrder.get(orderId);
    if (usd === undefined) throw new Error(`no USD amount recorded for order ${orderId}`);
    return usd;
  },
});

const settlement = new Settlement(rail.provider, rail.provider);
const handler = createCustomerApi({
  menu,
  settlement,
  // The invoice is authoritative: 2fiat quotes sats against a live rate, so a
  // menu price can only ever be an estimate.
  price_from_rail: true,
  eur_of: (id) => menu.find((m) => m.id === id)?.eur,
  on_order_created: (orderId, eur) => {
    if (eur === null) return; // the API refuses before this point
    usdByOrder.set(orderId, rail.usdFor(eur));
  },
});

console.log(JSON.stringify({
  listening: PORT,
  listening_host: HOST,
  menu_items: menu.length,
  rail_evidence_bearing: isEvidenceBearing(RAIL_URL),
  nwc_configured: Boolean(nwcUrl),
  price_source: "invoice (2fiat quotes sats; menu totals are estimates)",
  usd_per_eur: railCfg.usd_per_eur,
  usd_per_eur_source: railCfg.usd_per_eur_source,
  card: railCfg.card_id.slice(0, 8),
}));

Deno.serve({ port: PORT, hostname: HOST }, handler);
