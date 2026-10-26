/**
 * Test server for the facilitator PWA: ONE origin serves both the API and the
 * page, exactly like production, so the grant cookie behaves the way it will
 * really behave (same-site, subdomain-scoped).
 *
 * Stub spawner: no browser, no money. Two seeded sessions cover the two states a
 * facilitator must act on correctly - the human step, and the dangerous unknown.
 */
import { handle, SessionStore, setStateReader, type Spawner } from "../src/session_api.ts";

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

const bFile = `/tmp/pwa-test-state-${b.session_id}.json`;
states.set(bFile, "outcome_unknown");

const WEB = new URL("../web/", import.meta.url);

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/web/facilitator.html" || url.pathname === "/") {
    const html = await Deno.readTextFile(new URL("facilitator.html", WEB));
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (url.pathname === "/mock-vnc") {
    const sid = url.searchParams.get("session") ?? "";
    return new Response(
      `<!doctype html><body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;height:100vh">
         <div style="text-align:center">
           <div style="font-size:13px;color:#8fa">mock noVNC · grant accepted</div>
           <div style="font-family:monospace;margin-top:8px">${sid}</div>
           <div style="margin-top:14px;padding:10px 18px;border:1px solid #333;border-radius:8px">
             [ venue captcha would render here ]
           </div>
         </div></body>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // Everything else is the session API, on the same origin as the page.
  return await handle(req, store, ctx);
});

console.log(JSON.stringify({ listening: PORT, seeded: [a.session_id, b.session_id] }));
