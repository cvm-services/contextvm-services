# FINDING 2 — the publish loop was sequential

*(Title corrected 2026-10-06: the original said "one silent relay suppresses every
reply". It does not suppress; it delays. See CORRECTION below.)*

> **CORRECTION (2026-10-06, same day, after merge -- cold cross-family review).**
> This finding's headline claim is **false**, and the evidence that falsifies it was
> already printed three lines below the claim. nostr-tools@2.25.2 sets
> `publishTimeout = 4400` and rejects with `new Error("publish timed out")` -- the
> log line this document quotes as its "signature" **is** that rejection. A
> connected-but-silent relay therefore **delays** the sequential loop by its ~4.4 s
> timeout and the loop then **continues**: it does not suppress the relays after it,
> and it was **not** the cause of the relay2-only failures (those are relay2
> refusing the reply -- see the correction in FINDING-3).
>
> The refuted text below is kept, not deleted: a caught wrong claim is worth more to
> the next reader than a quiet edit. Corrected on branch
> `fix/claim-vs-code-publish-rationale`.
>
> **What is true, and what the fix actually buys:** a silent relay used to charge its
> full 4400 ms to *every* reply before the next relay was attempted, so the delays
> summed across the relay set -- and a reply could not reach a healthy relay until
> the silent one's timeout elapsed. Publishing concurrently with a per-relay deadline
> bounds total publish latency to one relay's timeout instead of their sum, and stops
> a rejected relay from holding a later one. The reconnect/ping half of the fix
> (defect 2 below) is verified behaviourally and is unaffected by this correction.


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

**REFUTED 2026-10-06 -- see the CORRECTION at the top of this file.** The paragraph
below is wrong on its central fact and is kept only for the record.

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

**REFUTED:** `publish timed out` is nostr-tools' own 4400 ms rejection -- a rejection,
not silence, and the loop continues after the catch. There was no stall.

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

## Post-fix measurement, same day (concurrent publish + per-relay deadline)

Four unit tests added and wired into `sendResponse`. Same three e2e runs, fixed
tree, same relays, 20s per-check timeout:

- primal only -- all_passed=true (4/4)
- both        -- all_passed=false (3/4); tools/list timed out
- relay2 only -- all_passed=false (2/4); menu and order timed out

The serialisation is gone: primal is served while relay2 is stalling, and the
both-relay run went from 0-2/4 to 3/4. What remains is a SECOND, independent
defect, visible now only because the first one no longer hides it:

    publish warning: Tried to send message '["EVENT", ...]' on a closed
    connection to wss://relay2.orangesync.tech/.

relay2 closes the socket DURING the run, and the server has no `onclose` handler
and no reconnect anywhere (grep: zero matches). Once relay2 closes, that Relay
object stays dead for the whole process lifetime -- so a client that reads only
from relay2 stops being served at the moment of the close, which is exactly the
2/4 shape above (initialize + tools/list answered, then nothing). `nak` proves a
FRESH connection to relay2 works, so reconnecting would recover it.

Two defects, both ours, one code path:
  1. sequential publish (fixed) -- one silent relay added its 4.4 s library
     timeout to every reply before the next relay was tried. NOT a suppression;
     corrected at the top of this file.
  2. no reconnect / no re-subscribe on close (open) -- a dropped relay is dead
     for the process lifetime.
This is why the original incident read as "relay2 cannot carry conversation":
the symptom was relay2-side, the causes were ours.

Measurement note: never `grep -oE 'publish warning: .*'` on this log -- those
lines embed whole gift-wrapped events (280 KB of ciphertext per run). Match a
bounded prefix.

## relay2's own defect, quantified (read-only diagnosis on the relay host)

Taken from relay2's own strfry container logs (last ~90 min; container
`tollgate-strfry` on 23.182.128.51, up since 2026-10-03, Restarts=0 -- so this is
NOT a restart artefact, it is per-connection churn):

- 2635 x `1006/Resource temporarily unavailable`   <- bulk drops, resource exhaustion
- 215 x `1006/auto ping timeout`
- 4+2+2 x `1006/Websocket frame size exceeded (131595 > 131072)` and larger
- 4 x broken pipe, 3 x socket status closed

This closes the relay2 question. relay2 does not "carry discovery but not
conversation" for a subtle reason: it drops connections continuously (EAGAIN),
closes idle ones on its own ping timeout, and rejects any frame over 128 KiB.
Our probes passed because a fresh connection in the first seconds is fine.

Consequence for us, after the fixes below landed: a client on PRIMAL is served
reliably (4/4, repeated). relay2-only still fails intermittently because the
relay itself keeps dropping the connection; our 10 s reconnect backoff cannot
paper over a relay that drops every ~30 s. relay2 needs an infra-side fix (fd/
resource limits, ping policy, frame cap) -- it is not fixable from the CVM server.

Final state, fixed tree, same relays:
- primal only -- all_passed=true (4/4), repeated
- both        -- 3/4 to 4/4 depending on relay2's mood in that window
- relay2 only -- 2/4, or a full hang, when relay2 is in a drop burst
