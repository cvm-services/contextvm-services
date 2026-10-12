# SOLVED: Chandi venue CVM answers a real client — and the last blocker is a relay size limit

## PROVEN (2026-10-13 01:12 UTC)

`services/restaurant-cvm/e2e_client.ts` against chandi-berlin, `all_passed: true`,
4/4 checks, 0 failures, 166,621-byte transcript:

    initialize      -> ok  serverInfo.name=contextvm-venue-server
    tools/list      -> ok  tools=[menu, order]
    tools/call:menu -> ok  total_items=167 venues=[chandi-berlin]
    tools/call:order-> ok  status=basket lines=2 total=18 venue=chandi-berlin deep_link=...

Transcript saved: evidence/steglitz-live/chandi-e2e-all_passed.json

## The last blocker (server's own words, verbatim)

    [venue-cvm] WARNING: outgoing event is 109741B, over the 65536B strfry
                maxEventSize default -- a relay keeping that default WILL reject
                this reply as "event too large"
    [venue-cvm] publish warning: publish timed out

The size-sorted replies: 870, 5053, 146331, 5927 bytes. The MENU reply is
~146 KB (109,741 B as one event), far over the relay's 65,536 B maxEventSize.
Small replies (initialize, tools/list, order) publish fine; the menu reply does
not. That is the actual mechanism behind the standing, misdiagnosed
"relay2 carries discovery but not conversation" finding.

## Fixes (in order of preference)

1. Chunk the menu response (the client already tolerates N chunks — the
   plan was written for this). Server-side, no infra change.
2. Raise maxEventSize on the relay. Note strfry's own docs say values over
   ~65536 can make the whole relay fail -- so this is NOT a free win.
3. `?venue_slug=` already filters to one venue; the client should use it and
   users should request sub-ranges. Does not fix the 146 KB single-venue case.

Recommendation: (1) chunking, since the goal is venue-agnostic and a 100-item
menu will always exceed a conservative relay limit.

## Two side findings

- Venue key files' `HEX=` field holds the SECRET hex, not the pubkey. The
  server copes (it treats SERVER_HEX as a secret), but the RUNBOOK tells the
  operator to pass `HEX=` as `--server`, which is an invalid pubkey and yields
  "bad point: is not on curve". Use the NPUB-decoded pubkey instead.
- `cvm-registry/tools/capture_menu.py`'s "all venues" default is a HARDCODED
  2-slug list, so 3 of the 6 onboarded venues (including chandi-berlin) are
  silently never chained into the served menu.json.
