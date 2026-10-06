# FINDING 2 — one silent relay suppresses every reply: our publish loop is sequential

Measured 2026-10-06, same session as FINDING 1.

## First, a correction to FINDING 1

FINDING 1 reported the most likely cause as "relay2 reaps long-lived idle sockets".
**That is falsified, and I am marking it as such rather than leaving it standing:**

- A raw WebSocket to relay2 survived **120s+** of idleness with an active subscription.
- A `npm:nostr-tools` Relay (the server's own library) survived **30s** and **75s** of
  idleness, then published three **4417-byte kind-1059** events, all resolved, socket
  still open, `relay.connected=true`.
- `nak` publishes to relay2 succeed at **5B** and **8000B** on a fresh connection.
- relay2 is therefore not idle-reaping (at those windows), not size-limited, not
  auth-gated, and not down.

Leaving the falsified claim in place would have sent the fix to the wrong side of the wire.

## The actual mechanism — ours

`services/restaurant-cvm/server.ts:635` publishes to relays **sequentially**:

    for (const relay of connectedRelays) {
      try {
        await relay.publish(signedGiftWrap);
      } catch (e) {
        log(`[venue-cvm] publish warning: ${(e as Error).message}`);
      }
    }

`relay.publish` has no timeout and resolves only when the relay sends its OK. A relay
that is *connected but silent* — an open socket that never answers — parks the loop.
Every relay after it in the list receives **no reply at all**, and the client's request
times out even though a healthy relay is in the set.

Evidence from the supervised unit's journal, one process, one minute:

    19:46:46  connected to wss://relay2.orangesync.tech, EOSE
    19:46:46  connected to wss://relay.primal.net; live; 2/2 relays connected
    19:47:14  publish warning: relay connection failed
    19:47:18  publish warning: publish timed out          <-- a stall, not a rejection
    19:47:28  Tried to send message ... on a closed connection

`publish timed out` is the signature. A rejection would have thrown a reason; silence
stalls the loop.

## Behaviour this explains that nothing else did

- **The client's relay choice does not determine delivery.** With both relays, runs
  failed on a *different pair of checks each time* (initialize+tools/list, then
  tools/list+order). A fresh relay2-only run after a unit restart delivered **2 of 4**
  replies. Both follow from a stall at whichever relay happens to be first.
- **Restarting the server does not cure it.** The stall is per-publish, not per-socket.
- **Primal-only rounds pass** when relay2 answers promptly, which is most of the time —
  hence the intermittency, and hence why a green primal run is not evidence that the
  relay set is healthy.

## Why this matters more than the relay question

Even with a perfect relay set, one slow relay makes the venue unreachable. The converse
also holds: this bug would *hide* a working relay2 behind a client timeout. Fixing relay2
first would have produced a green run that taught us nothing.

## Fix (designed, not yet applied)

Publish to all relays concurrently with a per-relay deadline, so one relay's silence
cannot delay or suppress any other relay's delivery. RED test first: a relay that never
answers must not prevent a healthy relay from receiving the reply, and must not delay
the response beyond the healthy path.

**Queued deliberately:** another worker is editing `server.ts` on branch `pizza-identity`.
Two writers on one file is how merges get interesting, so this lands after that does.

## Still open on the relay2 side

*Why* relay2's socket goes silent/half-dead (as opposed to closed — my probes show fresh
connections are fine). A read-only diagnosis of the relay's config and logs is dispatched
separately. This is now a secondary question: the blocker above is independent of it.
