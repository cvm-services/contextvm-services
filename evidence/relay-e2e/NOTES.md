# Relay E2E — Stage-1 venue CVM server answering a real client over a real relay

Date: 2026-10-06. Branch: relay-e2e. Server commit: fcf9220 (this tree, plus the
uncommitted wrapper fix that is part of this commit).

Dispatched worker (deleg_8a4030cd) died on an API connection error after landing
commit 8196ce4 and never pushed it; it never ran a round-trip. Work was banked by
the parent (push of 8196ce4 == fcf9220, then this run).

## What was run
  VENUE_SERVER_RELAYS=wss://relay2.orangesync.tech,wss://relay.primal.net \
    services/restaurant-cvm/run-venue-server.sh         (serving side)
  deno run --allow-net --allow-env services/restaurant-cvm/e2e_client.ts \
    --server <fe700a09..> --relay wss://relay2.orangesync.tech --relay wss://relay.primal.net --json

Client identity is ephemeral (generated per run, never persisted). The venue secret
is read from the 0600 key file into the process env by the wrapper and never appears
on a command line or in this evidence.

## Result — all_passed: true
  server identity  fe700a09094950660077447bedd4e0b3abc14a82e95227b313aebf83b7798984
                   == the live announced doppelt-kaese-berlin pubkey (fe700a09..)
  server relays    2/2 connected (relay2.orangesync.tech, relay.primal.net)
  initialize       serverInfo.name=contextvm-venue-server
  tools/list       [menu, order]
  tools/call menu  total_items=188 venues=[doppelt-kaese-berlin, pizza-e-pasta-ruedesheimerplatz]
  tools/call order status=basket lines=2 total=22.3 deep_link=https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase

Raw artefacts: server.log (serving side), request-response.json (full inner events + MCP).

## Honest scope — what this does NOT prove
1. The round-trip ran over wss://relay.primal.net only. The client was passed --relay
   twice; std/flags keeps only the LAST value without collect:[], so the client never
   used relay2.orangesync.tech even though the server connected to it (2/2). Proven:
   the server serves on the announced set. NOT yet proven by this run: a client that
   reaches it VIA relay2. Follow-up commit fixes the client flag and re-runs.
2. Reachability is of the SERVING PROCESS, not of the announcement. The published
   11317 events still declare the pre-Stage-1 requirements (see PLAN-0005 item 7),
   so nothing about the now-running server is discoverable from them yet. Republish
   remains the parent call.
3. Both venues are served under ONE identity (doppelt, fe700a09). A pizza client
   addressing whatever pubkey pizza was announced under does not reach this server.
   Verify the pizza announcement pubkey on the relay before treating pizza as reachable.
