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
import { OrderFlow, type VenueOutcome } from "../src/order_flow.ts";
import { FacilitatorAuth } from "../src/facilitator_auth.ts";
import { getEventHash, verifyEvent } from "npm:nostr-tools";


const PORT = Number(Deno.env.get("PWA_TEST_PORT") ?? "8795");

// Real signature verification, real event ids - the same pair the server uses.
const allowlist = new Set<string>();
const auth = new FacilitatorAuth({
  allowlist,
  verify: (e) => verifyEvent(e as never),
  hash: (e) => getEventHash(e as never),
  expected_url: `http://127.0.0.1:${PORT}/auth/verify`,
  challenge_ttl_ms: 120_000,
  token_ttl_ms: 3_600_000,
});
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
const ctx = { tokens, grant_ttl_ms: 600_000, auth, admin_token: "admin-token-xyz" };

/** Create a session through the real API, exactly as the spawner path would. */
const seed = async (order_id: string) =>
  await handle(
    new Request("http://x/sessions", {
      method: "POST",
      headers: { authorization: "Bearer tok-demo", "content-type": "application/json" },
      body: JSON.stringify({ order_id }),
    }),
    store, ctx,
  ).then((r) => r.json());

// Seed: one normal human step, one unconfirmed outcome (the case that must never
// be refunded blind).
const a = await seed("TG-1001");
const b = await seed("TG-1002");

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

// ---- venue leg, switchable by the test -------------------------------------
let venueMode: "requires_human" | "failed" | "confirmed" = "requires_human";
const refunds: Array<{ order_id: string; reason: string; ref: string }> = [];

const venue = {
  async checkout({ order_id }: { order_id: string; sats: number }): Promise<VenueOutcome> {
    if (venueMode === "failed") return { status: "failed", reason: "item sold out" };
    if (venueMode === "confirmed") return { status: "confirmed", ref: "TB-AUTO-1" };
    return { status: "requires_human", session_id: `sess_${order_id}` };
  },
};
const refundRail = {
  async refund(order_id: string, reason: string) {
    const ref = `rf_${refunds.length + 1}`;
    refunds.push({ order_id, reason, ref });
    return { ref };
  },
};
const flow = new OrderFlow(settlement, venue, refundRail);

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
  if (url.pathname === "/signer.js" || url.pathname === "/vendor/noble.js" || url.pathname === "/vendor/qr.js") {
    const name = url.pathname === "/signer.js" ? "signer.js" : url.pathname.replace(/^\//, "");
    return new Response(await Deno.readTextFile(new URL(name, WEB)), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/web/operator.html") {
    return html(await Deno.readTextFile(new URL("operator.html", WEB)));
  }
  if (url.pathname === "/web/customer.html") {
    return html(await Deno.readTextFile(new URL("customer.html", WEB)));
  }
  if (url.pathname === "/web/vendor/qr.js") {
    // customer.html is served under /web/, so its relative ./vendor/qr.js
    // resolves here. The production path is /order-next/vendor/qr.js.
    return new Response(await Deno.readTextFile(new URL("vendor/qr.js", WEB)), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
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

  // Test-only: the venue REJECTED the order after payment. Runs through
  // OrderFlow so the real refund rule is exercised (refund only on a KNOWN
  // failure), not a shortcut that just flips a state.
  if (url.pathname === "/__test__/venue/fail" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    venueMode = "failed";
    try {
      const r = await flow.placeOrder(String(body.order_id ?? ""));
      venueMode = "requires_human";
      return new Response(JSON.stringify({ ok: true, result: r }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      venueMode = "requires_human";
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
  }

  if (url.pathname === "/__test__/refunds") {
    return new Response(JSON.stringify({ refunds }), { headers: { "content-type": "application/json" } });
  }

  // Test-only: the venue accepted the order. In production this arrives from the
  // harness after the facilitator solves the captcha; here it is explicit so the
  // customer's screen can be shown reacting to a real state transition.
  if (url.pathname === "/__test__/venue/confirm" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const id = String(body.order_id ?? "");
    const ref = String(body.ref ?? "TB-TEST-0001");
    try {
      settlement.confirm(id, ref);
      return new Response(JSON.stringify({ ok: true, order: settlement.get(id) }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
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
      // A paid order is what a facilitator is asked to act on: create the session
      // the second phone will take control of.
      if (body?.state === "paid" && body?.order_id) await seed(String(body.order_id));
    }
    return res;
  }

  return await handle(req, store, ctx);
});

console.log(JSON.stringify({ listening: PORT, seeded: [a.session_id, b.session_id] }));
