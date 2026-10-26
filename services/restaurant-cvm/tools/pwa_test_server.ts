/**
 * Test server for BOTH PWAs on one origin, exactly like production:
 *   /web/facilitator.html   facilitator app
 *   /web/customer.html      customer app
 *   /menu, /orders*         customer API
 *   /sessions*              session API
 *
 * Stub rails: no browser, no wallet, no venue, no money. The provider's behaviour
 * is switchable so the test can walk the state that matters most — a payment whose
 * outcome is UNKNOWN — and prove the UI tells the truth about it.
 *
 * The `__test__` route exists only in this harness and is never mounted in serve.ts.
 */
import { handle, SessionStore, setStateReader, type Spawner } from "../src/session_api.ts";
import { Settlement, type InvoiceIssuer, type Provider, type ProviderResult } from "../src/settlement.ts";
import { createCustomerApi, type MenuItem } from "../src/customer_api.ts";

const PORT = Number(Deno.env.get("PWA_TEST_PORT") ?? "8795");
const states = new Map<string, string>();

const spawn: Spawner = async (order_id, _fac, session_id) => {
  const state_file = `/tmp/pwa-test-state-${session_id}.json`;
  states.set(state_file, "awaiting_human");
  return {
    novnc_url: `http://127.0.0.1:${PORT}/mock-vnc?session=${session_id}`,
    expires_at: Date.now() + 3_600_000,
    state: "awaiting_human",
    state_file,
  };
};

setStateReader((path) => {
  const st = states.get(path);
  return st ? JSON.stringify({ state: st }) : null;
});

const store = new SessionStore(spawn);
const tokens = new Map([["tok-demo", "fac-alice"]]);
const ctx = { tokens, grant_ttl_ms: 600_000 };

// Seed: one normal human step, one unconfirmed outcome (the case that must never
// be refunded blind).
const a = await handle(
  new Request("http://x/sessions", {
    method: "POST",
    headers: { authorization: "Bearer tok-demo", "content-type": "application/json" },
    body: JSON.stringify({ order_id: "TG-1001" }),
  }),
  store, ctx,
).then((r) => r.json());
const b = await handle(
  new Request("http://x/sessions", {
    method: "POST",
    headers: { authorization: "Bearer tok-demo", "content-type": "application/json" },
    body: JSON.stringify({ order_id: "TG-1002" }),
  }),
  store, ctx,
).then((r) => r.json());

states.set(`/tmp/pwa-test-state-${b.session_id}.json`, "outcome_unknown");

// ---------------- customer side --------------------------------------------
const MENU: MenuItem[] = [
  { id: "m1", name: "Margherita", sats: 890 },
  { id: "m2", name: "Diavola", sats: 1090 },
  { id: "m3", name: "Birra 0,5 l", sats: 320 },
];

let railMode: ProviderResult["status"] = "unknown";
const pending = new Set<string>();

const provider: Provider = {
  async pay() {
    if (railMode === "settled") return { status: "settled", provider_ref: "stub" };
    if (railMode === "failed") return { status: "failed" };
    return { status: "unknown" };
  },
  async lookup() {
    if (railMode === "settled") return { status: "settled", provider_ref: "stub_lookup" };
    if (railMode === "failed") return { status: "failed" };
    return { status: "unknown" };
  },
};

const issuer: InvoiceIssuer = {
  async issue(sats, orderId) {
    // Deterministic, invoice-shaped; the amount is always the order's own.
    return { bolt11: `lnbc${sats * 10}n1p4dfeg4p${orderId}`.padEnd(190, "0"), amount_sats: sats };
  },
};

const settlement = new Settlement(provider, issuer);
const customer = createCustomerApi({ menu: MENU, settlement });

// The harness reconciles unknown payments, which is what a real operator/service
// would do. Without this the "unknown" state would never resolve and the test
// could not prove the transition to paid.
setInterval(() => {
  for (const id of [...pending]) {
    settlement.reconcile(id)
      .then((o) => { if (o.state !== "outcome_unknown") pending.delete(id); })
      .catch(() => {});
  }
}, 400);

const WEB = new URL("../web/", import.meta.url);
const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/web/facilitator.html" || url.pathname === "/") {
    return html(await Deno.readTextFile(new URL("facilitator.html", WEB)));
  }
  if (url.pathname === "/web/customer.html") {
    return html(await Deno.readTextFile(new URL("customer.html", WEB)));
  }
  if (url.pathname === "/mock-vnc") {
    const sid = url.searchParams.get("session") ?? "";
    return html(
      `<!doctype html><body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;height:100vh">
         <div style="text-align:center">
           <div style="font-size:13px;color:#8fa">mock noVNC · grant accepted</div>
           <div style="font-family:monospace;margin-top:8px">${sid}</div>
           <div style="margin-top:14px;padding:10px 18px;border:1px solid #333;border-radius:8px">
             [ venue captcha would render here ]
           </div>
         </div></body>`,
    );
  }

  // Test-only rail control; never mounted in serve.ts.
  if (url.pathname === "/__test__/rail" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    railMode = (body.status ?? "unknown") as ProviderResult["status"];
    return new Response(JSON.stringify({ railMode }), { headers: { "content-type": "application/json" } });
  }

  if (url.pathname === "/menu" || url.pathname.startsWith("/orders")) {
    const res = await customer(req);
    // Track unknown payments so the harness can reconcile them.
    if (req.method === "POST" && /\/orders\/[^/]+\/pay$/.test(url.pathname)) {
      const body = await res.clone().json().catch(() => ({}));
      if (body?.state === "outcome_unknown" && body?.order_id) pending.add(body.order_id);
    }
    return res;
  }

  return await handle(req, store, ctx);
});

console.log(JSON.stringify({ listening: PORT, seeded: [a.session_id, b.session_id] }));
