# REPORT — venue CVM publish path: two defects found, both fixed; relay2 quantified

Branch `fix/publish-concurrency` (PR #17). All work is committed and pushed:
`c848c8b` (fix + RED tests), `324fe91`/`eda90e6` (evidence), `89d6f0d` (durability),
`7a3578a` (relay2 quantification).

## What was asked (items 1-4) and where each stands

1. **Merge #15** — DONE. It was `CONFLICTING` (`#13` landed as a squash, so the
   histories diverged on the same files). Merged main in, resolved the three
   add/add files to this branch's supersets, proved the delta was only the
   relay-list work (23 lines + 28 test lines), suite 65/0. main = `595e92a`,
   verified by reading main's own blobs.

2. **Fix relay2's socket lifetime** — the measurement falsified the premise, and
   the real causes turned out to be OURS. Two defects, both fixed:

   - `server.ts` published SEQUENTIALLY (`for ... await relay.publish(...)`).
     a relay that is connected but SILENT charged its whole library publish
     timeout (nostr-tools `publishTimeout = 4400ms`) to every reply before the
     next relay was attempted, so the delays summed across the relay set. Fixed:
     concurrent publish with a per-relay deadline.
     CORRECTED 2026-10-06 (cold review, after merge): an earlier revision of this
     bullet said `relay.publish` "has no timeout" and that one silent relay
     "suppressed" every relay after it. Both are false -- the library rejects at
     4400 ms and the loop continues. Refuted wording preserved in
     evidence/relay-e2e/FINDING-2-sequential-publish-suppresses-every-reply.md.
     RED first (4 tests failed: `TS2305 no exported member 'publishToRelays'`),
     GREEN 73/0.
   - `nostr-tools`' `enableReconnect`/`enablePing` were never set, so
     `AbstractRelay.handleHardClose` took the else branch and a dropped socket
     stayed dead for the process lifetime. The library already implements
     reconnect-with-backoff AND re-fires every open subscription on reopen —
     fixing this is two flags, not a hand-rolled supervisor. RED first, GREEN
     74 unit / 75 net, including a behavioural test that a socket closed 200 ms
     after open is reconnected AND re-subscribed.

   relay2 itself is then quantified from its own strfry logs (90 min):
   2635 x `1006/Resource temporarily unavailable`, 215 x `1006/auto ping
   timeout`, several `Websocket frame size exceeded (131595 > 131072)`,
   container up since 2026-10-03 with Restarts=0. relay2 drops connections
   continuously; that is an infra defect on the relay host, not something the
   CVM server can fix.

   End state, fixed tree, same relays: **primal-only 4/4 reproducible**;
   both-relays 3/4-4/4 depending on relay2's window; relay2-only 2/4 or a hang
   during a drop burst.

3. **Pizza identity decision** — resolved by PR #16: one supervised instance per
   announced identity. pizza is served under its OWN announced key
   (`ef070a5d...`) instead of both venues being served under doppelt's. Proof:
   `all_passed=true`, 4/4 checks, for BOTH venues over primal
   (`evidence/pizza-identity/*-e2e-primal.json`). RED first
   (`evidence/pizza-identity/RED-unfixed.log`).

4. **Republish from main** — NOT done, and deliberately. It was gated on 1+2.
   Our side of 2 is fixed; relay2's side is not. Republishing today advertises
   relay2 reachability that still does not hold. Decision needed: republish with
   a primal-scoped claim, or hold until relay2's fd/ping/frame limits are fixed.

## Live state

- `venue-cvm-server.service` + `venue-cvm-server-pizza.service`: active+enabled,
  `Restart=always`, `Linger=yes`, 2/2 relays each. NOTE: both still run the
  UNMERGED tree (`WorkingDirectory` = `~/worktrees/cs-pizza-identity`), so the
  live service does NOT yet have the two publish-path fixes. After #16/#17 merge,
  repoint both units at the deployed checkout.
- Open PRs: **#17** (publish fix + durability), **#16** (pizza identity),
  **#14** (announced-schema drift) — all yours to merge.
- Tests: 74 unit (1 ignored) + 75 net, `deno check` clean.

## Lesson recorded in the repo

`grep -oE 'publish warning: .*'` over the server log dumps whole gift-wrapped
events (~280 KB/run). Match a bounded prefix.
