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

const spawn: Spawner = async (order_id) => {
  // Deliberately unimplemented here: the launcher is a separate process and its
  // wiring is the next step. Failing loudly beats returning a URL that leads
  // nowhere - a session the dashboard believes in but no browser backs.
  throw new Error(
    `no spawner wired for order ${order_id}: run tools/captcha_handoff.sh and register the session`,
  );
};

const store = new SessionStore(spawn);
const port = Number(Deno.env.get("CVM_SESSION_API_PORT") ?? "8791");
const grantTtl = Number(Deno.env.get("CVM_GRANT_TTL_MS") ?? "120000");

Deno.serve({ port, hostname: "127.0.0.1" }, (req) =>
  handle(req, store, { tokens, grant_ttl_ms: grantTtl }));
