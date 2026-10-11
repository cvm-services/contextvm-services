1|# REPORT — venue CVM publish path: two defects found, both fixed; relay2 quantified
2|
3|Branch `fix/publish-concurrency` (PR #17). All work is committed and pushed:
4|`c848c8b` (fix + RED tests), `324fe91`/`eda90e6` (evidence), `89d6f0d` (durability),
5|`7a3578a` (relay2 quantification).
6|
7|## What was asked (items 1-4) and where each stands
8|
9|1. **Merge #15** — DONE. It was `CONFLICTING` (`#13` landed as a squash, so the
10|   histories diverged on the same files). Merged main in, resolved the three
11|   add/add files to this branch's supersets, proved the delta was only the
12|   relay-list work (23 lines + 28 test lines), suite 65/0. main = `595e92a`,
13|   verified by reading main's own blobs.
14|
15|2. **Fix relay2's socket lifetime** — the measurement falsified the premise, and
16|   the real causes turned out to be OURS. Two defects, both fixed:
17|
18|   - `server.ts` published SEQUENTIALLY (`for ... await relay.publish(...)`).
19|     a relay that is connected but SILENT charged its whole library publish
20|     timeout (nostr-tools `publishTimeout = 4400ms`) to every reply before the
21|     next relay was attempted, so the delays summed across the relay set. Fixed:
22|     concurrent publish with a per-relay deadline.
23|     CORRECTED 2026-10-06 (cold review, after merge): an earlier revision of this
24|     bullet said `relay.publish` "has no timeout" and that one silent relay
25|     "suppressed" every relay after it. Both are false -- the library rejects at
26|     4400 ms and the loop continues. Refuted wording preserved in
27|     evidence/relay-e2e/FINDING-2-sequential-publish-suppresses-every-reply.md.
28|     RED first (4 tests failed: `TS2305 no exported member 'publishToRelays'`),
29|     GREEN 73/0.
30|   - `nostr-tools`' `enableReconnect`/`enablePing` were never set, so
31|     `AbstractRelay.handleHardClose` took the else branch and a dropped socket
32|     stayed dead for the process lifetime. The library already implements
33|     reconnect-with-backoff AND re-fires every open subscription on reopen —
34|     fixing this is two flags, not a hand-rolled supervisor. RED first, GREEN
35|     74 unit / 75 net, including a behavioural test that a socket closed 200 ms
36|     after open is reconnected AND re-subscribed.
37|
38|   relay2 itself is then quantified from its own strfry logs (90 min):
39|   2635 x `1006/Resource temporarily unavailable`, 215 x `1006/auto ping
40|   timeout`, several `Websocket frame size exceeded (131595 > 131072)`,
41|   container up since 2026-10-03 with Restarts=0. relay2 drops connections
42|   continuously; that is an infra defect on the relay host, not something the
43|   CVM server can fix.
44|
45|   End state, fixed tree, same relays: **primal-only 4/4 reproducible**;
46|   both-relays 3/4-4/4 depending on relay2's window; relay2-only 2/4 or a hang
47|   during a drop burst.
48|
49|3. **Pizza identity decision** — resolved by PR #16: one supervised instance per
50|   announced identity. pizza is served under its OWN announced key
51|   (`ef070a5d...`) instead of both venues being served under doppelt's. Proof:
52|   `all_passed=true`, 4/4 checks, for BOTH venues over primal
53|   (`evidence/pizza-identity/*-e2e-primal.json`). RED first
54|   (`evidence/pizza-identity/RED-unfixed.log`).
55|
56|4. **Republish from main** — NOT done, and deliberately. It was gated on 1+2.
57|   Our side of 2 is fixed; relay2's side is not. Republishing today advertises
58|   relay2 reachability that still does not hold. Decision needed: republish with
59|   a primal-scoped claim, or hold until relay2's fd/ping/frame limits are fixed.
60|
61|## Live state
62|
63|- `venue-cvm-server.service` + `venue-cvm-server-pizza.service`: active+enabled,
64|  `Restart=always`, `Linger=yes`, 2/2 relays each. NOTE: both still run the
65|  UNMERGED tree (`WorkingDirectory` = `~/worktrees/cs-pizza-identity`), so the
66|  live service does NOT yet have the two publish-path fixes. After #16/#17 merge,
67|  repoint both units at the deployed checkout.
68|- Open PRs: **#17** (publish fix + durability), **#16** (pizza identity),
69|  **#14** (announced-schema drift) — all yours to merge.
70|- Tests: 74 unit (1 ignored) + 75 net, `deno check` clean.
71|
72|## Lesson recorded in the repo
73|
74|`grep -oE 'publish warning: .*'` over the server log dumps whole gift-wrapped
75|events (~280 KB/run). Match a bounded prefix.
76|

---

# REPORT — 2026-10-11: PR #38 review fixes (A: verification anchor, B: la-mama price semantics)

Worker `deleg_30e58f42` was dispatched with two findings and **timed out at 3600 s / 107 calls**.
It had already committed+pushed A (`a6f9432`) and left B complete-but-uncommitted on disk.
The manager verified the tree, ran the full suites, and pushed B as `6426f5b`. Nothing was re-run
from scratch and no work was lost.

## Finding A — the e2e expectation was derived from the artefact under test (BLOCKING)

Reproduced before the fix, per the reviewer's experiment (scratch dir, never /tmp): a hand-typed
`venues/bogus-fabricated-venue/venue.json` (no `evidence/`, no `adapter.py`, no source, prices
999.99/1234.56, `captured_at` 2099) was **SERVED**, and `deno test --allow-read services/restaurant-cvm/`
reported `ok | 41 passed | 0 failed | 1 ignored`. Any record passed. Cause: the expectation was
recomputed from the same records the server serves (`e2e_client.ts` `expectTotal` from `loadVenues()`
vs `server.ts` summing the same files; `server_test.ts` `expectedCatalogue()` re-walked `venues/` and
imported `validateAdapter` from the module under test).

Fix (commit `a6f9432`): new `services/restaurant-cvm/anchor.ts` — a COMMITTED anchor (`venues/anchors.json`,
canonical JSON + sha256 + served-projection hash + evidence check), a generator
(`venues/tools/menu_anchors.ts`), `servedVenueProjection()` in `server.ts` so the reply, the anchor and
the tests hash the SAME bytes, e2e expectations taken from the anchor and compared against the live
reply hash, 5 new anchor/evidence tests in `server_test.ts` + 2 in `e2e_client_test.ts`, and the real
anchor wired into the ngit CI lane (`deno task verify` = check + test + anchors + venues:check).
AFTER: the same fabricated venue **FAILS 4 tests**. `capture_menu.py --check` (the one genuine
independent check, which rebuilds from committed evidence) is now wired into CI, and it fails on a
perturbed price.

## Finding B — 44 of la-mama's 104 prices were the venue's "From" STARTING prices (money-relevant)

la-mama is `service_method: pickup` and the venue the operator intends to run the real money test
with, and the customer's sats price is derived from this catalogue — so a floor published as an exact
price leaves the facilitator short by the difference. The capture declared `skip_lines: ["From"]`,
which DELETED the qualifier; nothing in `venue.json` recorded that those figures were floors
(`grep -c From venue.json` = 1, only the `skip_lines` entry).

Fix (commit `6426f5b`): `capture_menu.py` gained `from_price_lines`; such a line binds to the pending
name line and marks the item `price_is_from: true` / `price_qualifier`, and EVERY item now states the
field so no reader infers it from absence. `venue_to_announcement.ts` reports
`from_priced_count` / `exact_priced_count` / `from_qualifiers` plus a note saying the figures are a
floor. `la-mama/venue.json` regenerated through the documented generator (never hand-edited); chandi
and doreedos regenerated for the uniform field (0 qualifiers each). `venues/anchors.json` regenerated:
la-mama `from_priced_count` 0 → 44. RED-first `services/restaurant-cvm/price_semantics_test.ts`
(6 tests), including one that FAILS if a "from"-qualified price is served or announced as exact, and
one that pins the money-test venue to the pickup venue so this cannot silently stop mattering.

**Open discrepancy for review:** the reviewer counted 43 "From" lines; the generator flags **44** items
(`anchors.json` `from_priced_count: 44`). Unreconciled — the cold review must settle which is right.
The other two Steglitz venues are unaffected (doreedos 0 qualifiers; chandi's 22 quarantined items are
excluded from the served menu, so only omissions, no wrong price).

## Verification as run (raw)

```
deno task test      -> ok | 134 passed | 0 failed | 1 ignored (10s)
deno task venues:check -> CHECK OK chandi-berlin   items=167 sha256=a869a50d7598
                          CHECK OK doreedos-steakhaus-berlin items=150 sha256=0549697b9df0
                          CHECK OK la-mama-berlin  items=104 sha256=3e769cec41a2
                          capture_menu --all: 3/3 venues verified
deno task anchors   -> CHECK OK venues/anchors.json venues=5 items=609 menu_sha256=73d37548184b
deno task check     -> clean
```

## NOT done (honest remaining work)

1. **The published record is still stale in production.** The live kind-11316 announcement for la-mama
   (published 2026-10-10) and the live `venue-cvm-server-la-mama.service` process both predate this fix,
   so they still present the 44 floors as exact prices. Regeneration + republish + redeploy is
   manager/operator-gated and was explicitly out of scope for this worker.
2. No cold adversarial review of B has happened yet (the reviewer asked for it; the manager is
   dispatching it).
3. PR #38 is NOT merged.

