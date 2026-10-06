# FINDING 3 — our own menu reply is too big for a 128 KiB relay frame cap

Measured 2026-10-06, byte-exact, by replicating `sendResponse()` (NIP-44 +
kind 1059 + the outer `["EVENT", ...]` frame) with a throwaway keypair:

| scope | items | response | published frame | vs 131072 cap |
|---|---|---|---|---|
| all venues | 188 | 77348 B | **131595 B** | **REJECTED** |
| doppelt-kaese-berlin | 76 | 35317 B | 66055 B | fits |
| pizza-e-pasta-ruedesheimerplatz | 112 | 42153 B | 76975 B | fits |

## Why this is not a coincidence

relay2's own strfry log, last ~90 min, contains:

    1006/Websocket frame size exceeded (131595 > 131072)

**131595 is our all-venues menu gift wrap, to the byte.** strfry's default
`maxWebsocketPayloadSize` is 131072 and it was never raised. So the 188-item menu
CANNOT be delivered on relay2 under any socket condition: the relay rejects the
frame outright. That is why relay2-only runs failed consistently on
`tools/call:menu` while other checks sometimes succeeded -- it was never
flakiness for that check, it was arithmetic.

It also means the earlier post-fix table needs one correction: the residual
`tools/call:menu` failure on relay2 was NOT (only) the EAGAIN churn. It is a
deterministic size rejection.

## What this changes

1. The per-venue instances (pizza/doppelt) both fit under the cap, so the
   identity split also restores menu delivery on relay2 for each venue. One
   instance per announced venue is the right shape for more than one reason.
2. An UNFILTERED instance (no `VENUE_SERVER_VENUES`) serves a menu that no
   strfry-default relay will carry. Running it can only ever half-work, and it
   fails silently from our side -- the relay drops the frame and the client just
   times out.
3. Primal accepts the 131595 B frame, so "it works on primal" was never evidence
   that the payload is acceptable.

## Follow-up (recommended, not yet done)

- Make the failure LOUD: measure the outgoing frame and warn when it exceeds a
  relay frame cap, so an undeliverable reply is visible locally instead of only
  in the relay's logs.
- Treat a venue-scoped menu as the contract (every announced venue gets its own
  instance), or paginate the menu, so no supported configuration can emit an
  undeliverable frame.
- Relay-side, if a larger payload is genuinely wanted:
  `maxWebsocketPayloadSize` in strfry.conf + recreate the container (drops live
  clients -- not to be done casually).
