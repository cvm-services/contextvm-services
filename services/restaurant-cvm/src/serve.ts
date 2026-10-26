/**
 * Listener for the session API. The handler is pure; this is the thin adapter
 * that Caddy's `forward_auth` and the dashboard actually talk to.
 *
 * Env (never literals):
 *   CVM_FACILITATOR_TOKENS  JSON {"<bearer-token>": "<facilitator-id>"}
 *   CVM_SESSION_API_PORT    default 8791  (LOOPBACK ONLY - Caddy proxies in)
 *   CVM_GRANT_TTL_MS        default 120000
 *
 * Spawning is injected, not imported: the harness launcher runs out of process,
 * so a bug here cannot fork browsers inside the API server.
 */
import { handle, SessionStore, type Spawner } from "./session_api.ts";

const tokens = new Map<string, string>(
  Object.entries(JSON.parse(Deno.env.get("CVM_FACILITATOR_TOKENS") ?? "{}")),
);
if (tokens.size === 0) {
  console.error("CVM_FACILITATOR_TOKENS is empty: refusing to start an API nobody can use");
  Deno.exit(2);
}

/**
 * Spawns the launcher, which drives a real browser and can therefore spend money.
 *
 * Deliberately explicit about three things:
 *   - it REFUSES unless CVM_LAUNCHER and CVM_PUBLIC_BASE are set, because a
 *     session without a public base yields a URL that leads nowhere;
 *   - it never returns until the launcher has written a session record, so a
 *     returned session always has a browser behind it;
 *   - on any failure it kills the child. A half-started session holding a live
 *     browser with no owner is the worst outcome available here.
 */
const LAUNCHER = Deno.env.get("CVM_LAUNCHER") ?? "";
const PUBLIC_BASE = Deno.env.get("CVM_PUBLIC_BASE") ?? "";
const HOLD = Deno.env.get("CVM_HOLD_SECONDS") ?? "600";

const spawn: Spawner = async (order_id, _facilitator, session_id) => {
  if (!LAUNCHER || !PUBLIC_BASE) {
    throw new Error(
      "spawner not configured: set CVM_LAUNCHER and CVM_PUBLIC_BASE (never hardcode them)",
    );
  }
  const out = `/tmp/cvm-session-${session_id}.json`;
  await Deno.remove(out).catch(() => {});
  const child = new Deno.Command("bash", {
    args: [LAUNCHER, "--hold", HOLD, "--no-password", "--public-base", PUBLIC_BASE,
           "--session-id", session_id, "--out", out],
    stdout: "null",
    stderr: "piped",
    env: { CVM_SESSION_STATE: `/tmp/cvm-state-${session_id}.json` },
  }).spawn();

  const deadline = Date.now() + 180_000;
  try {
    while (Date.now() < deadline) {
      try {
        const raw = await Deno.readTextFile(out);
        const rec = JSON.parse(raw);
        if (rec.novnc_url) {
          return {
            novnc_url: rec.novnc_url,
            expires_at: Date.parse(rec.expires_at),
            state: "preparing",
            // Hand over the harness's state file so this API can stay in sync
            // instead of reporting `preparing` forever.
            state_file: rec.state_file,
          };
        }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`launcher wrote no session record within 180s (order ${order_id})`);
  } catch (e) {
    // Never leave a browser running that nothing is tracking.
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    throw e;
  }
};

// Sessions persist across restarts. Without this the API forgot every session
// while the harness kept running - observed live: a restarted API orphaned a
// browser session that was still holding a venue checkout.
// Grants are NOT persisted: a restart invalidates access (fail closed).
const storePath = Deno.env.get("CVM_SESSION_STORE") ?? "/var/lib/cvm/sessions.json";
const store = new SessionStore(spawn, () => Date.now(), { path: storePath });
const port = Number(Deno.env.get("CVM_SESSION_API_PORT") ?? "8791");
const grantTtl = Number(Deno.env.get("CVM_GRANT_TTL_MS") ?? "120000");

Deno.serve({ port, hostname: "127.0.0.1" }, (req) =>
  handle(req, store, { tokens, grant_ttl_ms: grantTtl }));
