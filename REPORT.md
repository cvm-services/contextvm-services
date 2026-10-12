# REPORT — Three Buddies Steglitz onboarded (PR #40), first Steglitz venue on an already-supported platform

Branch `worker-base/three-buddies-berlin-stacked` (stacked on PR #38's `worker-base/AV-STEGLITZ-1`).
Commits: `b43dbbc` (venue record, from the worker), `e36e468` (contract + freshness fixes).
PR: https://github.com/cvm-services/contextvm-services/pull/40

## What was asked

Work with subagents to find a suitable restaurant in Berlin Steglitz and add it to the list of
supported restaurants. A suitable venue was **found** (6 candidates, 5 carded for later) and one was
**onboarded**.

## The venue

**Three Buddies Steglitz** — Albrechtstraße 131, 12167 Berlin, Ortsteil Steglitz. Burger /
Italian-American. FoodAmigos storefront, so the repo's existing `doppelt-kaese-berlin` recipe applies:

```
GET https://www.threebuddies.de/api/store                                        -> store 481, franchise_slug
GET https://app.foodamigos.io/api/companies/threebuddies/data?hostname=threebuddies.de -> company 550
GET https://app.foodamigos.io/api/companies/550/menus                            -> menus/products/prices
```

**The company-id trap:** the storefront binds store 481 to company **509**, the company payload returns
**550**, and BOTH answer `/menus` 200 — but 509's menu is a different, non-burger menu (Kofta/Qutab). The
headed-browser capture in `evidence/` is the tie-breaker: the venue's own ordering route requests
`/companies/550/menus` and the prices it renders match 550's. The disagreement is recorded in
`venue.company_binding`, not hidden.

Record: 1 menu, 12 sections, **100 listed items (100 priced)**, 1.50–17.40 EUR, 22 unlisted products
tracked separately.

## Two contract gates the record failed — both fixed in the generator, never by hand

1. **`adapter declares no credential owner`.** `venue.adapter` was flat (`credential_owner`,
   `credential_scope`, `idempotency_key`, `order_receipt`, `payment_authority` as a bare string). The
   served contract (`services/restaurant-cvm/server.ts:210-258`) requires `credentials.owner`,
   `payment_authority`, `idempotency`, `receipt` as **nested objects**. Now emitted nested, matching
   `venues/doppelt-kaese-berlin`, with honest class-1 (`deep_link_human`) values —
   `credentials.owner: "none"` is only legal for a human-handoff adapter, which this is.
2. **`served without captured_at (G7: freshness is a property of the capture)`.** The FoodAmigos adapter
   recorded no capture time at all, so the menu's freshness was unknowable. `fetch_all` now stamps
   `captured_at` **once, at fetch**, into the committed `evidence/raw/_provenance.json`, and the builder
   reads it back — so a rebuild from unchanged evidence stays byte-identical. `menu.captured_at` is where
   `server.ts:375` reads it.

Both refusals were **correct fail-closed behaviour** (ADR-0007): the gate works. The fix is the record.

## Verification (raw)

```
deno task verify          -> 146 passed | 0 failed | 1 ignored      (was 134 before this branch)
anchors                   -> CHECK OK venues=6 items=709 menu_sha256=30c232d0a95f
venues:check              -> 3/3 (chandi 167 / doreedos 150 / la mama 104) byte-identical
adapter.py --check        -> MATCH (byte-identical rebuild from committed evidence)
adapter.py --selftest     -> OK deterministic=1 duplicate_skus=0 priced=+100 sections=12
adapter.py --verify-rendered -> items_on_page=61 matched=61 not_in_venue_json=0 mismatches=0
adapter.py --anchor       -> entries=61 matched=61 mismatches=0
adapter.py --negative-test -> PERTURBED-FAILURE 'Blue Cheese Burger': venue.json=9.9 page=8.90
                             -> NEGATIVE TEST OK (a vacuous check would have passed)
```

The price check is **not self-derived** — it compares the record against text a real browser rendered on
the venue's own ordering page, and a mutation test proves the comparison can fail.

**The re-fetch that produced the timestamp also re-verified the source.** All three payload hashes came
back IDENTICAL to the committed evidence (`142060d5…`, `468482e7…`, `88d3e71d…`), so the menu is unchanged
and `captured_at = 2026-10-11T22:24:13+00:00` is a real capture, not a back-fill.

New test `tests/three_buddies_venue_test.ts` (+12 tests) asserts the contract shape AND calls the server's
own `validateAdapter`, then empties `credentials.owner` and requires the same validator to **reject** —
so the conformance check is falsifiable.

## Redaction

No e-mail, no `nsec`, no key material in the committed evidence; the venue's own published phone
(`+49 30 48625381`) is the one phone the record carries, deliberately. The worker's first fetch caught a
real leak (the venue's e-mail inside `about_us` prose, not a named field) and fixed the scrubber; the
record asserts no `[REDACTED` placeholder survives.

## Addendum — the worker's later commits were salvaged (1da4687)

The onboarding worker timed out at 3600s with no summary. Its last commits never reached this
branch and were recovered from `origin/worker-base/three-buddies-berlin`:

- `tests/three_buddies_venue_test.ts` — the full 364-line non-vacuous suite
- `evidence/announcements/three-buddies-berlin.{11316,11317}.json` — publishable dry-run evidence
- `venues/three-buddies-berlin/evidence/ANNOUNCEMENT.md` — **NOT PUBLISHED** + the exact operator
  publish/read-back commands + the one-key-per-venue warning
- `CUISINE_TAGS` entry + the venue joined to all 11 venue-wide loops
- a real redaction fix this branch lacked (phone regex welded "131\n\n12167" and matched lat/lon
  runs, leaving a false-positive `[REDACTED-PHONE]` in the committed `store.json`; 12 -> 11 placeholders)

The two contract fixes made here are re-applied on top (the worker's branch predates them), and the
two announcement files were regenerated with THIS branch's emitter so they carry
`menu.price_semantics` — the field la-mama's floors make mandatory.

`deno task verify` 146 passed | 0 failed | 1 ignored; anchors 6 venues / 709 items.

## NOT done — the honest remainder

1. **Not served.** No venue CVM runs it and nothing is announced for it, so a customer cannot discover
   or order from it yet — card `t_a63cf51a`, **blocked on the operator gate** (step 1 mints a NEW
   announced venue identity, which is publishing-gated).
2. PR #38 and PR #40 are both **unmerged**, so the served/anchored `venues/` set on main is still 5.
3. Cold adversarial review of `e36e468` has not run (delegation was quota-blocked at the time:
   dispatch gate exit 1, `ours` 100% locked, weekly reset 2026-10-13T11:22Z).
4. Five further Steglitz candidates remain documented in `triage`: `t_3e791731` (Khao Thai),
   `t_3295d44e` (Limonello), `t_46c41e69` (Akiko Sushi), `t_4fd9c215` (Dosa King — identity
   contradiction), `t_32d4763c` (Bunter Panda — endpoint unresolved).
`grep -oE 'publish warning: .*'` over the server log dumps whole gift-wrapped
events (~280 KB/run). Match a bounded prefix.

---

# REPORT — AV-STEGLITZ-1: third venue CVM unit for chandi-berlin (2026-10-11)

Adds `venue-cvm-server-chandi.service`, a THIRD, isolated systemd --user unit serving the
Berlin-Steglitz venue `chandi-berlin` from a NEW dedicated checkout, without touching the
two live production venue units. Governing plan: PLAN-0005-orderable-venues.

## Verdict

- Third unit is **active**, `NRestarts=0`, running from the new checkout.
- The two production units are **untouched**: same `MainPID` 6140 / 6139, `NRestarts=0`,
  and their unit files' sha256 **identical to the pre-change baseline**.
- The CVM **answers the `menu` tool over the announced relay set** for chandi-berlin:
  `tools/call:menu` -> `total_items=167`, `venues=["chandi-berlin"]`, `all_passed=true`,
  exit 0 — reproduced 3x on the announced set and once on primal alone.
- **Menu for chandi-berlin: 167 items, all priced, currency EUR, price range 0.50 – 95.00,
  single fulfilment method `dine_in`.** (Matches the published kind-11316 content.)
- Honest caveat: relay2 alone does NOT deliver the menu reply — the serialized reply event
  is 87889 B, over relay2/strfry's default 64 KiB `maxEventSize`, which rejects it as
  `invalid: event too large`. Small replies (initialize / tools/list / order) DO flow over
  relay2 and requests DO land there. This is a pre-existing relay-side limit shared by all
  venue instances (server.ts constants `RELAY_EVENT_CAP_BYTES`/`RELAY_FRAME_CAP_BYTES` and
  the branch's FINDING-3), NOT something introduced by this unit.

## 1. The new checkout (real clone, not under /tmp)

```
$ git ls-remote https://github.com/cvm-services/contextvm-services.git 'refs/heads/worker-base/AV-STEGLITZ-1'
3a36152da2c3946b36b1a385cb465757c16a03bd	refs/heads/worker-base/AV-STEGLITZ-1

$ git clone --branch worker-base/AV-STEGLITZ-1 --single-branch \
    https://github.com/cvm-services/contextvm-services.git /home/c03rad0r/repos/contextvm-services-steglitz
Cloning into 'contextvm-services-steglitz'...

$ git rev-parse HEAD ; git status --porcelain
3a36152da2c3946b36b1a385cb465757c16a03bd
(clean)

$ ls venues/chandi-berlin/
README.md  evidence  venue.json
```

Note: the *pre-existing local* ref in `/home/c03rad0r/repos/contextvm-services` for the same
branch name resolved to `b6765d90` (stale). The dedicated clone was made fresh from GitHub so
the served code/data is exactly the pinned tip `3a36152d`.

## 2. Identity proof (key file <-> announcement), no secret printed

```
$ grep -oE '[A-Z_]+=' ~/.hermes/secrets/venues/chandi-berlin.nsec
VENUE=
NSEC=
HEX=
NPUB=
CREATED=

$ stat -c '%a %n' ~/.hermes/secrets/venues/chandi-berlin.nsec
600 /home/c03rad0r/.hermes/secrets/venues/chandi-berlin.nsec

$ nak decode npub14l8cgx87w0jalch6727rxuffqfl22w3t2s0hn09pk55a02zew73qd8nl2a
afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2
```

The file's `NPUB` decodes to `afcf8418…` == the announcement pubkey == the `pubkey` the server
logs at boot. The secret `HEX` value was never printed, passed on any command line, or written
to any file.

## 3. Announcement already published — verified, not republished

```
$ nak req -k 11316 -d chandi-berlin -a afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2 \
    wss://relay2.orangesync.tech
{"kind":11316,"id":"9dca19f52775f78b6d9a7eb010ca7563c023e13635fa453e2f549f2624e24d82",
 "pubkey":"afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2", ...
 "tags":[["d","chandi-berlin"],["t","cvm:service:restaurant"],["cvm:tier:fulfilment"],
         ["g","u336"],["g","u336re"],["g","u336recg"],["cap","tool:order","0","sats"], ...],
 "content": "{... \"menu\":{\"item_count\":167,\"priced_count\":167,... \"min_price\":0.5,\"max_price\":95 ...}"}
```

## 4. The unit

`~/.config/systemd/user/venue-cvm-server-chandi.service`:

```
[Unit]
Description=ContextVM venue CVM server — chandi-berlin (Stage 1: menu + order deep-link handoff)
Documentation=https://github.com/cvm-services/contextvm-services/blob/relay-e2e/evidence/relay-e2e/FINDING-relay2-carries-discovery-but-not-conversation.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/c03rad0r/repos/contextvm-services-steglitz
Environment=VENUE_SERVER_RELAYS=wss://relay2.orangesync.tech,wss://relay.primal.net
Environment=VENUE_SERVER_VENUES=chandi-berlin
Environment=VENUE_SERVER_KEY_FILE=%h/.hermes/secrets/venues/chandi-berlin.nsec
ExecStart=/home/c03rad0r/repos/contextvm-services-steglitz/services/restaurant-cvm/run-venue-server.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Installed with:

```
$ systemctl --user daemon-reload
$ systemd-analyze --user verify ~/.config/systemd/user/venue-cvm-server-chandi.service
(no findings for this unit; the two lines printed are unrelated units:
 hermes-gateway.service.d/openbao-keys.conf and /usr/lib/systemd/user/spice-vdagent.service)
$ systemctl --user enable --now venue-cvm-server-chandi.service
Created symlink '/home/c03rad0r/.config/systemd/user/default.target.wants/venue-cvm-server-chandi.service'
  -> '/home/c03rad0r/.config/systemd/user/venue-cvm-server-chandi.service'.
```

## 5. Unit is up and stable (not restart-looping)

```
$ systemctl --user is-active venue-cvm-server.service venue-cvm-server-pizza.service venue-cvm-server-chandi.service
active
active
active

$ systemctl --user show <the three units> -p Id,ActiveState,SubState,NRestarts,MainPID,ExecMainStartTimestamp,WorkingDirectory
Id=venue-cvm-server.service
ActiveState=active SubState=running NRestarts=0 MainPID=6140
ExecMainStartTimestamp=Thu 2026-10-08 21:16:58 CEST
WorkingDirectory=/home/c03rad0r/repos/contextvm-services

Id=venue-cvm-server-pizza.service
ActiveState=active SubState=running NRestarts=0 MainPID=6139
ExecMainStartTimestamp=Thu 2026-10-08 21:16:58 CEST
WorkingDirectory=/home/c03rad0r/repos/contextvm-services

Id=venue-cvm-server-chandi.service
ActiveState=active SubState=running NRestarts=0 MainPID=1702693
ExecMainStartTimestamp=Sun 2026-10-11 22:35:53 CEST
WorkingDirectory=/home/c03rad0r/repos/contextvm-services-steglitz
```

Journal (`journalctl --user -u venue-cvm-server-chandi.service`):

```
Started venue-cvm-server-chandi.service - ContextVM venue CVM server — chandi-berlin ...
[venue-cvm] starting; pubkey afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2
[venue-cvm] menu loaded: 167 items across 1 venues
[venue-cvm] connected to wss://relay2.orangesync.tech (reconnect + ping on)
[venue-cvm] EOSE from wss://relay2.orangesync.tech
[venue-cvm] connected to wss://relay.primal.net (reconnect + ping on)
[venue-cvm] live; 2/2 relays connected
[venue-cvm] EOSE from wss://relay.primal.net
[venue-cvm] WARNING: outgoing event is 87889B, over the 65536B strfry maxEventSize default ...
[venue-cvm] publish warning: invalid: event too large: 87889          <-- only these are the
                                                                        relay's reply rejections
$ journalctl --user -u venue-cvm-server-chandi.service -p err
-- No entries --
```

The only non-informational lines are the size warnings/rejections for the large menu reply
(section 7). There is no crash, no auth error, and no relay-close loop; `NRestarts=0` after
~20 minutes up and four client rounds.

## 6. The CVM answers `menu` over the relay — the e2e proof

`e2e_client.ts` requires `--server <64-hex>` and one or more `--relay`; it generates an
**ephemeral** client key (no venue key is needed or accepted). Exact commands:

```
$ cd /home/c03rad0r/repos/contextvm-services-steglitz
$ ~/.local/bin/deno run --allow-net --allow-read --allow-env services/restaurant-cvm/e2e_client.ts \
    --server afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2 \
    --relay wss://relay2.orangesync.tech --relay wss://relay.primal.net \
    --venue chandi-berlin --json
EXIT=0
all_passed: True
 - initialize       True | serverInfo.name=contextvm-venue-server
 - tools/list       True | tools=["menu","order"]
 - tools/call:menu  True | total_items=167 venues=["chandi-berlin"] expected=["chandi-berlin"]/167
 - tools/call:order True | status=basket lines=2 total=18 venue=chandi-berlin deep_link=https://chandi-restaurant.com/menue/
```

Raw transcript (evidence/steglitz-bringup/e2e-chandi-berlin.json) decodes the `menu` tool
result to:

```
menu payload top keys: ['total_items', 'venues', 'rejected_venues']
venue_slug: chandi-berlin | item_count: 167 | currency: EUR
items: 167 | priced items: 167 | min: 0.5 | max: 95 | order methods present: ['dine_in']
```

This exact run was repeated three times (22:44, 22:52, and the relay-isolation matrix) with the
same result, so it is not a one-shot fluke.

## 7. Independent relay-side + per-relay isolation

Independent check that requests actually reach the chandi identity on relay2 (kind 1059 is the
gift-wrap envelope, `#p` = server pubkey), captured live while the client ran:

```
$ nak req -k 1059 -p afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2 --limit 4 wss://relay2.orangesync.tech
{"kind":1059,"id":"9fcd3508ae09739a59dd4c54b2e7a29469f7b44e4354910c54ab0fb58c59eb2b",
 "pubkey":"e1cdfacf...","tags":[["p","afcf8418fe73e5dfe2faf2bc337129027ea53a2b541f79bca1b529d7a85977a2"]], ...}
```

Per-relay isolation (same client, one relay at a time):

```
relay2 ONLY:  all_passed=False
 - initialize       True
 - tools/list       True
 - tools/call:menu  False | no response (timeout)     <-- 87889B reply > relay2's 64KiB maxEventSize
 - tools/call:order True

primal ONLY:  all_passed=True
 - initialize       True
 - tools/list       True
 - tools/call:menu  True | total_items=167 venues=["chandi-berlin"]
 - tools/call:order True
```

So: the announcement lives on relay2 and primal; requests land on both; the *large* menu reply
is refused by relay2's default event-size limit and delivered by primal. The announced set as a
whole answers the `menu` tool correctly (section 6). This matches the branch's own FINDING-3
and is not new behaviour from this unit.

## 8. The two production units were NOT touched

```
BEFORE (baseline, 22:13):
d55a99fc4f3bacf591b5700ca766e11b497605d881bf10e231a8c1b8bd1d7039  venue-cvm-server.service
9ca2139287972c279b1e8553240041dfad6c58ee69e2af266afb65431f9eee69  venue-cvm-server-pizza.service
mtime=2026-10-06 22:57:29  (both)

AFTER (22:54):
d55a99fc4f3bacf591b5700ca766e11b497605d881bf10e231a8c1b8bd1d7039  venue-cvm-server.service   <- identical
9ca2139287972c279b1e8553240041dfad6c58ee69e2af266afb65431f9eee69  venue-cvm-server-pizza.service <- identical
mtime=2026-10-06 22:57:29  (both, unchanged)
MainPID 6140 / 6139 and ExecMainStartTimestamp 2026-10-08 21:16:58 — unchanged
```

Neither file was edited, neither service was restarted/reloaded-into-restart. The production
checkout `/home/c03rad0r/repos/contextvm-services` is unchanged: `HEAD=9d502071440...` with the
same pre-existing modifications (`services/restaurant-cvm/server_test.ts`,
`tools/venue_to_announcement.ts`, untracked `.worktrees/`) that were present before this task.

## 9. Constraints observed

- Nothing written under `/tmp` (`ls /tmp/contextvm*` -> no such file).
- No secret in any command line, log, or file: the wrapper extracts `HEX` from the 0600 key file
  into the process env only; `--allow-env` is limited to `SERVER_HEX,VENUE_SERVER_RELAYS,VENUE_SERVER_VENUES`.
- No `git push`, no commit, no `git add`; the checkout's only new/modified paths are this report,
  `PROGRESS.md`, and the untracked `evidence/steglitz-bringup/` transcripts.

## 10. Reproduce / artefacts

- Unit: `~/.config/systemd/user/venue-cvm-server-chandi.service` (enabled).
- Checkout: `/home/c03rad0r/repos/contextvm-services-steglitz` @ `3a36152d`.
- Raw evidence in `evidence/steglitz-bringup/`: `e2e-chandi-berlin.json`,
  `e2e-chandi-berlin-run2.json`, `e2e-chandi-berlin-run3.json`, `e2e-relay2-only.json`,
  `e2e-primal-only.json`, `nak-relay2-1059.txt`, `final-state.txt`.
- Re-prove: `systemctl --user is-active venue-cvm-server-chandi.service` and the e2e command in section 6.
