# relay2.orangesync.tech carries discovery, but not conversation

Found 2026-10-06 while proving the Stage-1 venue CVM server answers a real client
over a real relay (PLAN-0005 criterion 7). This is an INFRASTRUCTURE finding, not a
server-logic finding. It is on our own relay.

## What was proven working

`wss://relay.primal.net`, repeated, all four checks green:

    initialize       serverInfo.name=contextvm-venue-server
    tools/list       [menu, order]
    tools/call menu  total_items=188 venues=[doppelt-kaese-berlin, pizza-e-pasta-ruedesheimerplatz]
    tools/call order status=basket lines=2 total=22.3 deep_link=https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase

The server serves as the announced identity:
`fe700a09094950660077447bedd4e0b3abc14a82e95227b313aebf83b7798984`.

## What fails

- `--relay wss://relay2.orangesync.tech` **only**: the client run times out (`exit=124`),
  zero responses of any kind. Not a partial answer — total silence.
- Both relays: nondeterministic. Run 2 answered `menu`+`order` and timed out on
  `initialize`+`tools/list`; run 3 answered a DIFFERENT pair (`initialize`+`menu`) and
  timed out on `tools/list`+`order`. Which requests survive varies per run, so this is
  not a positional or "first request" artefact.
- Serving-side log, this run:

        13  Tried to send message '["EVENT",{kind:1059,...}]' on a closed connection to wss://relay2.orangesync.tech/.
         1  publish timed out
         1  relay connection failed

  Those 13 events are the server's own gift-wrapped replies (NIP-59 kind 1059, `#p` =
  the client pubkey of the run), i.e. answers that were produced and then thrown away.

## What it is NOT

relay2 is not down, not size-limited, not auth-gated. Fresh-connection probes, all
`success`:

    5-byte     kind-1 event -> relay2   success
    8000-byte  kind-1 event -> relay2   success
    8000-byte  kind-1 event -> primal   success

Discovery over relay2 also works: `nak req -k 11317` returned all seven announced CVM
events, and the server itself connects and gets EOSE (`[venue-cvm] connected to
wss://relay2.orangesync.tech`, `EOSE from wss://relay2.orangesync.tech`, `live; 2/2 relays connected`).

## Most likely cause (not yet pinned)

relay2 appears to reap LONG-LIVED idle WebSocket connections. Every CVM has the shape
"connect, subscribe, sit idle until addressed, then publish the answer" — so a socket
reaped during the idle window turns each later answer into a publish on a closed
connection. That fits all three observations: fresh-connection publishes succeed;
sustained sessions fail; and which request fails varies with exactly when a request
lands relative to the reaping/reconnect.

Not proven, because I did not time the reaping window. Cheapest decisive check for
whoever owns relay2: open one WS, subscribe, stay idle, and record the wall-clock
moment the socket closes. Then compare against the relay's own connection timeouts
and against any nginx/proxy `proxy_read_timeout` in front of it.

## Why it matters

The venues are announced ON relay2. An announcement is only useful if a client that
discovers it there can then TALK to the service. Today the discovery half works and the
conversation half does not, so announcing an orderable venue on relay2 would advertise
reachability that does not hold. Fixing relay2's connection lifetime is a prerequisite
for the republish step, not an optimisation.
