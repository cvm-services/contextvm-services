# Chandi chained into the supported list + the real cause of the 5 "not served" venues

## DONE: chandi-berlin (Berlin-Steglitz) is now in the served list

`/home/c03rad0r/repos/cvm-registry/site/menu.json`:
    venues served: ['chandi-berlin']
    chandi-berlin  Chandi Restaurant  167 items  relays ['wss://relay.primal.net']

Captured with a real end-to-end ContextVM round trip
(`all_passed: true`, 4/4 checks, transcript kept at
contextvm-services/evidence/steglitz-live/chandi-e2e-all_passed.json).

## Real cause of the other five (NOT a bug in the capture code)

Their SYSTEMD UNITS are not running the deployed code. Two independent defects:

1. three-buddies / la-mama units ExecStart the PRODUCTION checkout
   (`~/repos/contextvm-services/.../run-venue-server.sh`), while chandi's unit
   ExecStart's the STEGLITZ checkout
   (`~/repos/contextvm-services-steglitz/...`). Different code per venue.
2. three-buddies' last successful relay activity was 2026-10-12 19:46, and it
   only ever logs EOSE from `relay2.orangesync.tech` - never from primal, even
   though its unit declares both relays. So its primal subscription is not
   live. A client addressed to it over primal gets silence (exit 124, empty).

So `three-buddies` / `la-mama` need their service re-established on a relay set
that actually carries their conversation, and their units pointed at one
checkout. That is a service-lifecycle fix, not a capture-code fix.

## Proof this is the truth and not a story

- chandi over primal: all_passed true, 167 items.
- three-buddies over primal: exit 124, 0 bytes, server journal silent.

Same client, same relay, same tool. The difference is the server side.

## capture_menu.py is now honest

Before: default venue list was hardcoded to 2 slugs, so an onboarded venue was
silently never served. Chandi sat unserved for exactly that reason.
After: auto-discovers every venue under contextvm-services/venues/, and records
non-answering venues in `_provenance.not_served` + a stderr WARNING instead of
dropping them silently.
