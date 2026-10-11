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
