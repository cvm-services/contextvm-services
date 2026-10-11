# REPORT — t_7d410f66 venue announcements re-derived from the venue rail

Branch: `worker-worker-base/t_7d410f66` (worktree `~/worktrees/t_7d410f66`).

Full evidence: `evidence/announcements/EVIDENCE-t7d410f66.md`.
Authoritative live state: `evidence/announcements/live-after-t7d410f66/TABLE.md`.

## Status

**Done.** The template district list is gone from the live announcement, the
venue's own geometry is declared instead, the one announcement that still needed
republishing was republished with the venue's own key, and every claim about the
rail was re-checked — except pizza's, which the rail (Cloudflare) refused.

## Deliverable 1 — re-derive each venue's fulfilment facts from its own rail

Both venue records carry a per-field provenance block (`provenance.fields`:
source call, URL, payload field, `fetched_at_utc`) plus
`provenance.not_verifiable_from_rail`, written by the earlier commits on this
card (`be46767` doppelt, `bec628d` pizza).

This run re-checked the *live* rails instead of trusting those copies:

- **doppelt (FoodAmigos storefront API)** — re-fetched 2026-10-09T23:37:43Z/44Z:
  `company` and `store` both **HTTP 200 with sha256 identical** to the capture of
  2026-10-09T22:44:30Z. The declared facts (5000 m circle centred on the venue's
  own coordinates, min order 20 EUR, fee 5 EUR, pickup 10 min, `work_schedule`
  hours) are still exactly what the rail publishes.
- **pizza (OrderYoyo `/oyy-api`)** — **could not be re-read**: HTTP 403 from the
  Cloudflare challenge, with a plain GET and with the committed cookie jar
  (2026-10-09T23:37:44Z and 23:38:03Z). Pizza's fields therefore rest on the
  committed 2026-10-05T01:37:14Z capture and are **not freshness-verified**.

Independently audited the retraction's arithmetic from the venue's own two
values: **4 districts inside the 5000 m circle, 11 of 15 outside**
(`recheck-doppelt-radius.py`), matching the retraction text.

## Deliverable 2 — unknowns marked as unknown

- doppelt `delivery.areas_named` → `null`, with `delivery.areas_retracted`
  carrying the withdrawn list, its `source_call`/`url`/fetch time and the reason.
- doppelt: postcode coverage, per-address reachability inside the circle → listed
  under `not_verifiable_from_rail`; `area_selector_url` is `null`, not a guess.
- pizza `delivery.areas` → status **UNKNOWN** (deliveryMode=PostCode; the
  `/delivery-area` route is behind Cloudflare), announced as `null`.

## Deliverable 3 — republished announcements

| venue | kind | event id (live, after) | action |
|---|---|---|---|
| doppelt-kaese-berlin | 11316 | `12ee1fdbc200243c891932b6e9751d21948ae126e13088aee2ab7504532beb34` | republished earlier in this card (first attempt) |
| pizza-e-pasta-ruedesheimerplatz | 11316 | `d58b21fbc10232a84d816de953aad31d608051b66776679eeb14a39bfb116d39` | **republished by this run** |
| doppelt-kaese-berlin | 11317 | `7b6a4010412b2765af09c9df7f0248702d8dc358f7571a9989be0b171d5148e1` | live already == emitter, no republish |
| pizza-e-pasta-ruedesheimerplatz | 11317 | `ace6d6ec802c5a080352698a8d01774b66c710427964b510151cb2bdfd0cf1f1` | live already == emitter, no republish |

- Signed by the venues' own keys (doppelt `fe700a09…`, pizza `ef070a5d…`);
  kinds 11316/11317 are NIP-16 replaceable, so these **replaced** the venue's
  previous announcements instead of forking the identity.
- Present on **both** announced relays (`relay2.orangesync.tech`,
  `relay.primal.net`), read back after publishing; live content and tags equal
  the tree's emitter output for all four events (`live-after-t7d410f66/VERIFY.txt`).
- Diffs: `LIVE-DIFF-t7d410f66.md` (what the relays actually changed — pizza 11316
  gained `area_mode`/`zones`/`areas_retracted` explicit nulls; no tag change) and
  the pre-existing `DIFF-t7d410f66.md` (artifact-level, both venues, both kinds).
- I deliberately did **not** republish the two kind-11317 events: their live
  content already equals the emitter's, so a republish would only churn the event
  id. Recorded here rather than done silently.

## Bonus: the defect that killed the first attempt

`tools/nostr.ts publish()` never closed its WebSocket, so the emit CLI printed
its event and then never exited — that is how the first attempt on this card died
(SIGTERM after ~28 min). Fixed (close on every exit path) with a RED-first test
that observes the socket close via a local relay:
`tools/nostr_publish_test.ts`, RED transcript in
`evidence/announcements/RED-publish-socket-hang.txt`, CLI exit proof in
`evidence/announcements/emit-exit-proof.txt` (`exit_code: 0`).

## Verification

- `deno task test` → **82 passed | 0 failed | 1 ignored**.
- `deno task test:net` → **83 passed | 0 failed** (includes a real
  publish→read-back to relay2) — `evidence/announcements/test-net.txt`.
- `deno check` clean on `tools/nostr.ts`, `tools/nostr_publish_test.ts`,
  `tools/emit-venue-announcement.ts`.
- Every readback script is idempotent and re-runnable; `recheck_rail.py` exits
  non-zero for the pizza 403 and that is reported, not swallowed.

## Explicit non-claims

- Pizza's declared fulfilment facts are **not** freshness-verified (rail 403);
  only their provenance record and the 2026-10-05 capture back them.
- No claim is made about which postcodes/addresses either venue actually
  delivers to: neither rail publishes it (doppelt: no endpoint; pizza: 403).
- The district distances are centroid-based approximations (≥ kilometres of
  margin), not survey measurements.
