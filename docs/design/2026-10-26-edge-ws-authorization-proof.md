# Edge authorization proof — does `forward_auth` gate a WebSocket?

**Date:** 2026-10-26
**Question:** the session API decides who may drive a browser, but Caddy proxies
noVNC regardless. Does `forward_auth` actually block a **WebSocket upgrade**, or
only the HTTP GET that precedes it? A route that checks the page but not the
socket is not access control — the socket *is* the display.

**Answer: yes, it gates the upgrade.** Measured, not reasoned.

## Setup

- `tools/edge_ws_proof.ts` — one process, two listeners: the real API handler on
  `8792` (stub spawner: no browser, no money) and a WebSocket echo on `6077`
  standing in for websockify.
- Reverse SSH tunnel `x280 → vps2fips` for both ports.
- Temporary Caddy vhost, since removed:

```
edgeproof.orangesync.tech {
    forward_auth 127.0.0.1:8792 {
        uri /edge/authorize?session=s_1_75401
    }
    reverse_proxy 127.0.0.1:6077
}
```

Session `s_1_75401` created via `POST /sessions`, controller acquired via
`POST /sessions/:id/control`, which returned grant `d83262e7…`.

## Results

| # | Request | Expected | Observed |
|---|---|---|---|
| 1 | `GET /vnc.html`, no grant | 401 | **401** |
| 2 | `GET /vnc.html`, `Cookie: cvm_grant=…` | 200 | **200** |
| 3 | **WS upgrade**, no grant | 401 | **401** |
| 4 | **WS upgrade**, `Cookie: cvm_grant=…` | 101 | **101** |

Case 4 returned `101 Switching Protocols` and the connection stayed open (curl
reported the timeout, which is what a successful upgrade looks like).

## What this establishes

- A leaked session URL is **no longer sufficient** to drive the browser, because
  the upgrade is refused without a live grant.
- The grant is honoured from a **cookie**, which is the transport noVNC can
  actually use — it cannot set request headers.
- Case 3 is the one that matters: the auth check applies to the upgrade, not only
  to the HTML.

## What this does NOT establish

- **Nothing is deployed.** The vhost was temporary and has been removed; the
  production session host still proxies straight through.
- The proof used a **stub spawner** — no real browser, no captcha, no money.
- **iOS Safari third-party-cookie blocking** was not tested. If Safari drops the
  cookie in an iframe, `forward_auth` fails closed and the operator sees a 401.
  Failing closed is right, but it is a product decision, not a bug to patch
  silently.
- The grant TTL was widened to 10 minutes for the proof; production default is 120s.

## Reproduce

```bash
deno run --allow-all services/restaurant-cvm/tools/edge_ws_proof.ts   # NOT bun: Deno.serve
ssh -f -N -R 8792:127.0.0.1:8792 -R 6077:127.0.0.1:6077 vps2fips
# add the vhost, substitute the session id from POST /sessions, reload caddy
```

**Kill patterns must be bracketed** (`edge_ws_proo[f]`). Twice during this work a
`pkill -f` pattern appeared verbatim in the operator's own command line and killed
the shell running it.
