/**
 * PROOF HARNESS — not production. Two listeners on one process:
 *   8792  the session API (real handler, STUB spawner: no browser, no money)
 *   6077  a WebSocket echo, standing in for websockify
 *
 * Exists to answer one question the unit tests cannot: does Caddy's
 * `forward_auth` actually gate a real WebSocket upgrade, or only the HTTP GET
 * that precedes it? A route that checks the page but not the socket is not
 * access control - the socket is the display.
 */
import { handle, SessionStore, type Spawner } from "../src/session_api.ts";

const stub: Spawner = async (order_id) => ({
  novnc_url: `http://127.0.0.1:6077/vnc.html?order=${order_id}`,
  expires_at: Date.now() + 3_600_000,
  // Already at the human step so `control` is legal without a real browser.
  state: "awaiting_human",
});

const store = new SessionStore(stub);
const tokens = new Map([["tok-fac-a", "fac-a"]]);

Deno.serve({ port: 8792, hostname: "127.0.0.1" }, (req) =>
  handle(req, store, { tokens, grant_ttl_ms: 600_000 }));

Deno.serve({ port: 6077, hostname: "127.0.0.1" }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => socket.send(`echo:${e.data}`);
    return response;
  }
  return new Response("ws echo (proof harness)", { status: 200 });
});

console.log("proof harness: api=8792 ws=6077");
