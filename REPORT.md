# Report — per-venue identity for the venue CVM server

## Outcome

Pizza e Pasta (Ruedesheimerplatz) is now reachable under its own announced pubkey
`ef070a5d…` with a menu scoped to pizza only and a real, orderable basket. The
fix is one server instance per announced identity, wired through a
`VENUE_SERVER_VENUES` filter.

## What changed

1. **`services/restaurant-cvm/server.ts`**
   - Added `parseVenueFilter(value)` — maps absent/empty to `null` (all venues),
     else a trimmed, deduped array of slugs.
   - `loadVenues(filter?)`, `buildIndex(filter?)`, `serve({ venues })` now thread
     an optional venue filter; a filtered instance loads and serves only those
     venues.
   - CLI reads `VENUE_SERVER_VENUES` and passes it through.

2. **`services/restaurant-cvm/server_test.ts`** — 4 RED tests added:
   - `parseVenueFilter` absent/empty/list behaviour.
   - a filtered instance serves ONLY that venue's menu (112 pizza items).
   - a filtered instance refuses an `order` for a venue it does not serve,
     naming the unknown venue (`unknown venue_slug: doppelt-kaese-berlin`).
   - a filtered instance still orders its own venue normally.
   Proved RED first (TS2305/TS2554 against the unfixed tree), then GREEN.

3. **`services/restaurant-cvm/run-venue-server.sh`** — reads/forwards
   `VENUE_SERVER_VENUES`, added it to `--allow-env`.

4. **`services/restaurant-cvm/e2e_client.ts`** — added `--venue` so a run asserts
   a single announced identity (menu slug set + item count + order against that
   venue). Unscoped runs keep the combined 188-item assertion.

5. **`deploy/`** — added `venue-cvm-server-pizza.service` (pizza key +
   `VENUE_SERVER_VENUES=pizza-e-pasta-ruedesheimerplatz`) and set
   `VENUE_SERVER_VENUES=doppelt-kaese-berlin` on the existing doppelt unit, so the
   two instances are 1:1 with their kind-11317 announcements.

## Proof (raw, committed under `evidence/pizza-identity/`)

Both runs driven by `e2e_client.ts` over `wss://relay.primal.net`:

| target | pubkey | menu | order |
|---|---|---|---|
| pizza | `ef070a5d…` | 112 items, `["pizza-e-pasta-ruedesheimerplatz"]` only | status=basket, 1 line, total 2.70, deep_link present |
| doppelt (regression) | `fe700a09…` | 76 items, `["doppelt-kaese-berlin"]` only | status=basket, 2 lines, total 22.30, deep_link present |

- `pizza-e2e-primal.json` / `doppelt-e2e-primal.json` — full transcripts,
  `all_passed: true`, `checks` all `ok`.
- `pizza-server.log` / `doppelt-server.log` — each instance's own journal:
  pizza loads 112 items/1 venue signed as `ef070a5d…`; doppelt 76/1 signed
  `fe700a09…`.

## Deployed

Both `systemd --user` units installed (`~/.config/systemd/user/`), enabled
`--now`, Linger already yes:

- `venue-cvm-server.service` — doppelt, 76 items, `fe700a09…`, 2/2 relays.
- `venue-cvm-server-pizza.service` — pizza, 112 items, `ef070a5d…`, 2/2 relays.

## Tests

`deno task test` → **69 passed | 0 failed** (baseline was 65).

## Known issue (pre-existing, not fixed here, not caused by this change)

relay2.orangesync.tech drops long-lived subscribed sockets (see
`evidence/relay-e2e/FINDING-…`). This work also surfaced a second relay2
limitation in the server logs: a 76-item (~66 KB) or 112-item (~77 KB) menu
gift-wrap is rejected by relay2 with `invalid: event too large`, while
`wss://relay.primal.net` accepts it. All proof above runs over primal, which
round-trips cleanly. This is a separate relay2 finding to be diagnosed in
parallel; not addressed here.

## Not done (by design)

No announcement was created or republished — publishing is the manager's call
and is gated. Nothing merged. Branch `pizza-identity` carries the code, tests,
units, and raw proof.
