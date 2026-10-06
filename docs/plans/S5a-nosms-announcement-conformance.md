# S5a — nosms CVM: conform the announcement to the tag contract

- **Card:** `t_38d3f879` (board `contextvm-services`)
- **Status:** implemented
- **Branch:** `pr/s5a-announce-conform` off `main` (`3f93093`)
- **Repos touched:** `contextvm-services` (contract surface + fixture), `nosms` (Python port, server, live re-announce)
- **Kit source of truth:** `cvm-services/cvm-service-kit` `pr/s2a-announce-emitter` @ `7bf4be6`

## What was wrong (live event on `wss://relay.primal.net`, verified 2026-10-05)

```
["d","nosms"] ["name","nosms"] ["t","sms"] ["t","contextvm"]
["contract","https://nosms.orangesync.tech/llms.txt"]
["cap","tool:sms.send","100","sats"] ["cap","tool:sms.send","500","sats"] ["cap","tool:sms.send","500","sats"]
["pmi","bitcoin-cashu","explicit_gating"]
```

| # | Gap | Rule | Fix |
|---|---|---|---|
| 1 | no `cvm:service:sms` | P2 MUST | kit emits it from `serviceClass` |
| 2 | no `cvm:req:none` sentinel | P15 | kit derives it from the recompute (**decision below**) |
| 3 | no `cvm:tier:<tier>` | P15 / D14 amendment | kit computes it (`financial`) |
| 4 | no `g` — **correct, kept** | P2 "MUST NOT publish a meaningless geohash" | none emitted; asserted by test |
| 5 | `contract` tag (non-standard) | P2 SHOULD use `r` | kit emits `r`; `contract` gone |
| 6 | 3 duplicate `cap` for one tool | P4 / ADR-0002 | one `cap`, flat `2900 sats` |

## Emitted surface (golden fixture `fixtures/nosms-11316.tags.json`)

```
["d","nosms"]
["t","cvm:service:sms"] ["t","sms"] ["t","contextvm"]
["t","cvm:req:payment.amount"] ["t","cvm:req:none"] ["t","cvm:tier:financial"]
["cap","tool:sms.send","2900","sats"]
["r","https://nosms.orangesync.tech/llms.txt"]
["pmi","bitcoin-cashu","explicit_gating"]      <- NOT from the kit (see finding)
["name","nosms"] ["about",…] ["website",…]     <- payload (D2)
```

`assertAnnouncementTags(tags, vocab)` → **OK** (0 violations, no tier mismatch, no sentinel warning).
Filterable surface is `d`/`r`/`t` only; everything else is payload.

## Decisions taken here (downstream S5b/S5c read these)

### 1. `serviceClass: "sms"` → `["t","cvm:service:sms"]`

The card writes `cvm:service:sms`; the class grammar is `^[a-z0-9]+(-[a-z0-9]+)*$`, so `sms`
is the exact spelling. (The live event's `["t","contextvm"]` is wrong under D3: that is a
transport word, not a service class.)

### 2. The sentinel IS published alongside `cvm:req:payment.amount`

`cvm:req:none` is the tag form of the shorthand **"tiers none/financial only"**
(`filter_shorthand`), not "the required-field list is empty". nosms requires money and
nothing personal, so tier `financial` (rank 1) ⇒ the sentinel is emitted **with** the field.
The sentinel is never counted in the recompute basis, so the pair is not self-contradictory.
The kit implements exactly this rule; it is now written down in
`docs/spec/service-inputs.md` §"When is the sentinel published?".

Only a declared *personal* field (`contact`+) alongside the sentinel is a lie about the
appetite — that stays forbidden and the reader warns on it.

### 3. No field for `to`/`body`

They are MCP tool arguments, not flow inputs. Declaring them would be the inflated appetite
ADR-0001 D14 / P15 minimisation forbids. `payment.amount` alone is the honest declaration.

### 4. Flat 2900 sats (ADR-0002 nosms) supersedes 100/500

```
price_sats = ceil(MULT × rail_replacement_usd × (1e8 / btc_usd)) = ceil(0.5 × 4.99 × 1e8/86462)
           = 2886 → rounded up to 2900 sats
```
Flat for domestic and international (the JMP plan is unlimited incl. international, so
destination no longer maps to cost). The `cap` MUST equal what the server charges; the
`nosms` parity test asserts the tag equals the value the port is fed.

### 5. FINDING — the kit emits no `pmi` (new work, not this card's scope)

At `7bf4be6` the kit has **no payment support at all**: `AnnounceInput` has no payment field,
`emitAnnouncementTags` never pushes `pmi`, and the kit README says *"Payments (CEP-8) and the
ring gate are still to come"*. `pmi` is a MUST for a paid service (ADR-0001 D5 / CEP-8), so it
is declared in exactly one place in `nosms` (`PAYMENT_TAGS`, labelled) and the kit gap is
tracked as its own card. This is not "forking the kit": the kit still owns every tag it
actually emits.

### 6. `pmi`/`name`/`about`/`website` are appended, not emitted by the kit

`name`/`about`/`website` are multi-letter payload (D2) the registry reads for display. The
validator ignores tag letters it does not own, so appending them to the kit's output keeps
`assertAnnouncementTags` green — proven by the test, not assumed.

### 7. The venue path appends the same payload tags (2026-10-06)

Section 6 is a rule, so it needs a second consumer to be a contract. The S4a venue
glue (`tools/venue_to_announcement.ts`) did not append anything, and the effect was
visible on the dashboard: both venue cards rendered as their bare slug
(`doppelt-kaese-berlin`) while the announcement itself looked complete — the name
was in the JSON content, and the registry never reads the content for it
(`tagValues(tags, "name")` in `cvm-registry/collector/lib.ts`; the card renders
`e.name ?? e.d`).

Fixed by the same shape as nosms: `venuePayloadTags()` returns
`name`/`about`/`website`, `venueWireTags()` appends them to the kit's contract
tags, and the CLI asserts the full appended set is still conforming (no
violations, tier still recomputing) before it prints or publishes. `aboutLine()`
is the one definition of the about text, shared by the tag and the content, so
the two cannot drift.

Live evidence (2026-10-06): all four events (11316 + 11317 x 2 venues) republished
to relay2 and primal, read back with `nak req`, live tag sets byte-equal to
`evidence/announcements/*.json`; live collect shows 4 services with real names.

## What is where

| Artifact | Purpose |
|---|---|
| `vendor/cvm-service-kit/` | byte-verbatim kit copy + `PROVENANCE.md` (commit sha, register hash) |
| `tools/nosms_announcement.ts` | the ONE description of the nosms input; emits through the kit |
| `fixtures/nosms-11316.tags.json` | golden fixture — the kit's own output, the parity reference |
| `tools/nosms_announcement_test.ts` | 12 tests: conformance, each gap, determinism, fixture stability |
| `docs/spec/service-inputs.md` | sentinel rule added |
| `nosms: app/announce.py` | port of `emitAnnouncementTags` + `assertAnnouncementTags` |
| `nosms: tests/test_announce_parity.py` | Python emitter diffed against the golden fixture |

## Reproduction

```bash
cd <contextvm-services worktree> && ~/.local/bin/deno task test      # 12 passed
                                       ~/.local/bin/deno task check-fixture
cd <nosms worktree> && .venv/bin/python -m pytest -q                 # all green
```

## Known limits (do not overclaim)

- The port proves **tag parity with the kit**, not wire parity with the live relay; the live
  read-back (`nak req -k 11316`) is the wire evidence and is pasted in the card result.
- Nothing here settles the `pmi`-in-kit gap (decision 5) — tracked separately.
