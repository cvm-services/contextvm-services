# Live evidence — 2026-10-07 republish: Stage-1 order schema visible to clients

Card `t_4c1f654f`. Run 2026-10-07 ~22:49–22:59 UTC. Worktree
`~/worktrees/cs-republish`, branch `pr/republish-announcements`, from
`origin/main` @ `e8be7ab`. All four events republished from `venues/*/venue.json`
via `tools/emit-venue-announcement.ts` (the merged emitter — no code or schema
was changed by this task). No claims here that a command did not print.

## 1. What was published (dry-run first, then signed)

Per-venue tag sets, identical for kind 11316 and 11317:

- **doppelt-kaese-berlin** — required: `cvm:req:order.items`,
  `cvm:req:order.fulfilment`, `cvm:req:order.when`, `cvm:req:contact.phone`;
  optional: `cvm:opt:ship.address`, `cvm:opt:contact.name`, `cvm:opt:order.notes`;
  tier `cvm:tier:fulfilment`; classes `cvm:service:restaurant`,
  `cvm:service:meatspace`; cap `["cap","tool:order","0","sats"]`.
- **pizza-e-pasta-ruedesheimerplatz** — identical shape: required
  `order.items`, `order.fulfilment`, `order.when`, `contact.phone`; optional
  `ship.address`, `contact.name`, `order.notes`; tier `cvm:tier:fulfilment`;
  classes `restaurant`, `meatspace`; cap `["cap","tool:order","0","sats"]`.

Delta vs the previously-published events (committed evidence): exactly
`+cvm:req:order.items`, `+cvm:req:order.when` in tags; in content, 9 diffs all
inside `tools[0]` — the old published order tool had an EMPTY inputSchema (no
properties, no required list) and a deep-link description; the new one carries
the full Stage-1 schema (`properties`: items, fulfilment, when, notes, ship,
contact, venue_slug; `required`: `[venue_slug, items, fulfilment, when]`) and a
"Build a basket … Checkout and payment happen on the venue's own page"
description. This publish is what makes the Stage-1 schema visible to clients.

Settlement: unchanged, no rail declared. cap 0 sats (unchanged); content
settlement block: doppelt `cvm_cap_sats: 0`, rail = descriptive only
("venue's own rail (FoodAmigos storefront: Adyen/Stripe/PayPal/cash)"); pizza
`cvm_cap_sats: 0`, `rail: null` (adapter recorded none). No `payment.method` /
`pmi` tag exists on either event. ADR-0004 satisfied.

## 2. Publish + READ-BACK PER RELAY (the evidence that counts)

Sign once with the venue key; publish to primal; replay the identical signed
event to relay2 (never re-signed). Pubkeys verified before signing from public
material only: doppelt → `fe700a0909495066…` (npub1lecq5…), pizza →
`ef070a5dcaaa368d…` (npub1aurs…), both matching the live announcements, so the
replaceable (kind, pubkey) events REPLACE, not duplicate.

| venue | kind | event id | primal | relay2 |
|---|---|---|---|---|
| doppelt | 11316 | `399f972a1b4d126abc6f3e194b886c7f26f50575b66c8243a55fa0c841f56b55` | OK accepted=true; read back by id: required=[contact.phone, order.fulfilment, order.items, order.when], ship.address NOT required, tier=cvm:tier:fulfilment, classes=[meatspace, restaurant], cap 0 sats | OK accepted=true; read back identical |
| doppelt | 11317 | `7b6a4010412b2765af09c9df7f0248702d8dc358f7571a9989be0b171d5148e1` | OK accepted=true; read back identical (content carries the Stage-1 inputSchema, required=[venue_slug, items, fulfilment, when]) | OK accepted=true; read back identical |
| pizza | 11316 | `a41f4e5c596a90372ac0f3447ab2ac7c2499163b263fdb18832a9a568524e294` | OK accepted=true; read back identical | OK accepted=true (msg empty); read back identical |
| pizza | 11317 | `ace6d6ec802c5a080352698a8d01774b66c710427964b510151cb2bdfd0cf1f1` | OK accepted=true; read back identical | OK accepted=true; read back identical |

Read-back method: fresh `REQ {"ids":[id]}` on a NEW socket per relay after
publish; the tag lists above are read from the relay-served event, not from the
publish call's own return value. Pubkeys served back match the intended authors
(no fallback-key duplicate).

## 3. relay2 did NOT refuse

The card expected a refusal: strfry `maxEventSize` 65536 vs 66045 B (doppelt) /
76965 B (pizza). Measured reality: the merged emitter publishes a menu SUMMARY,
so the events are ~5.4 KB (11316) / ~3.4 KB (11317) as dry-run JSON (~5.6 KB
signed) — far under the limit. relay2 accepted all four (`OK … accepted=true`,
empty msg) and serves each back by id. There is no refusal text to quote
because there was no refusal. `vps-infra/t_e4500c96` stays valid for the
gift-wrap size issue it tracks, but it did not gate this publish.

## 4. Live catalog re-check

The dashboard collector reads `relay2.orangesync.tech` + `relay.damus.io` on a
timer (it does NOT read primal). relay2 now carries the new events, so the
collector's next run will pick them up.

- before: catalog generated_at 1791405175 (`2026-10-07T20:32:55Z`), both venues
  `required: [contact.phone, order.fulfilment]`
- after: recorded in the card comment at completion time — see the kanban card
  for the generated_at and required list the refreshed catalog shows.

## 5. Artifacts

- `evidence/announcements/{slug}.{11316,11317}.json` — refreshed dry-run
  artifacts (unsigned, the committed convention). The test suite asserts the
  published 11317 carries exactly one `name` tag equal to the venue's own name
  — 16 passed | 0 failed after the refresh.
- Dry-run + signed JSON of this run under `/tmp/republish/` (ephemeral).
- Temp key files were derived 0600 outside the repo, used, and wiped; the
  secret was never printed, never on argv, never committed.
