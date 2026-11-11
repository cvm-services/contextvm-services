# Evidence — venue announcements re-derived from the venue's own rail (t_7d410f66)

Card: `Venue metadata: re-derive declared delivery areas/hours from the venue rail`.
Republished events, the per-field source + fetch time, and — explicitly — the
fields that could **not** be verified from the rail.

Everything below was produced by scripts in this directory; each script is
listed in "How to reproduce" at the end.

---

## 1. What was wrong

`doppelt-kaese-berlin` announced `fulfilment.delivery` with a list of 15 Berlin
district **names** (`Mitte, Kreuzberg, Friedrichshain, … Pankow.`) taken from the
storefront payload's `data.delivery_areas`. The venue is at Laubacher Str. 11,
14197 Berlin (Friedenau / Wilmersdorf). The same rail's company payload publishes
the venue's delivery area as **one circle of radius 5000 m centred on the
venue's own coordinates**, and 11 of those 15 districts lie outside it. A client
reading the announcement had a district list as its only "area"; a customer in
Friedenau could have been told they were out of area, or an order could have been
promised to an address the venue will not serve.

The emitted announcement now states the venue's own geometry (`area_mode:
"radius"`, the circle, min order, fee), sets `areas_named` to `null`, and keeps
the withdrawn list in `delivery.areas_retracted` with its source call and reason
so the retraction stays auditable.

## 2. Re-derivation, per venue

### 2.1 doppelt-kaese-berlin — re-verified LIVE in this run

| field (venue record) | payload field | source URL | capture | re-checked in this run |
|---|---|---|---|---|
| `delivery.area` (circle r=5000 m, centre = venue coords) | `company.delivery_zones[*].geometry_data` | `https://app.foodamigos.io/api/companies/doppeltkase/data?hostname=doppelt-kaese-berlin.de` | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** @ 2026-10-09T23:37:43Z |
| `delivery.mode`, `delivery.min_order`, `delivery.fee` | `company.delivery_zones[0]` | as above | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** |
| `opening_hours` | `company.work_schedule` | as above | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** |
| `pickup.estimated_minutes` = 10 | `company.average_order_preparation_time.min` | as above | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** |
| `order_methods` | `company.has_pickup, company.has_delivery` | as above | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** |
| `delivery.areas_retracted` (withdrawn district list) | `data.delivery_areas` | `https://www.doppelt-kaese-berlin.de/api/store` | 2026-10-09T22:44:30Z | **HTTP 200, sha256 identical** |

`evidence/announcements/recheck-t7d410f66/` holds the machine record. The
re-fetch hash equals the hash recorded at capture time, so the declared facts are
still exactly what the rail publishes — not a stale copy.

**Independent audit of the retraction's arithmetic** — `recheck-doppelt-radius.py`
recomputes the circle-vs-district test from the two values now in the venue
record (centre = `venue.address.lat/lon` = the venue's own coordinates; radius =
`delivery.zones[0].radius_m`). Result: **4 inside, 11 of 15 outside**, matching
the retraction:

```
inside : Wilmersdorf 1.63 km, Schöneberg 2.67 km, Charlottenburg 3.95 km, Tempelhof 4.43 km
outside: Tiergarten 5.22 km, Kreuzberg 6.37 km, Moabit 6.73 km, Mitte 7.71 km,
         Neukölln 8.12 km, Wedding 9.04 km, Treptow 9.04 km, Friedrichshain 10.31 km,
         Prenzlauer Berg 10.42 km, Pankow. 12.25 km, Lichtenberg 13.13 km
```

District positions in that script are approximate public centroids (not a rail
value) and every margin is kilometres, so the inside/outside verdict does not
depend on the approximation. The retraction text quotes "Prenzlauer Berg ~10.6
km, Pankow ~12.2 km, Lichtenberg ~13.0 km"; this run measures 10.4 / 12.3 / 13.1
km with its own centroids — same verdict, within centroid tolerance.

### 2.2 pizza-e-pasta-ruedesheimerplatz — NOT re-verifiable from the rail now

| field (venue record) | payload field | source URL | capture |
|---|---|---|---|
| `delivery.mode`, `delivery.available`, `delivery.enabled`, `delivery.estimated_minutes`, `delivery.fee`, `delivery.minimum_order`, `delivery.schedule` | `deliveryMode`, `serviceMethods`, `openingHours.hasDelivery`, `deliveryTime`, `deliveryFee`, `deliveryMinimumAmount`, `openingHours.allDaysDeliveryHours` | `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/restaurant/45842?timeSensitive=false` | 2026-10-05T01:37:14Z |
| `venue.opening_hours` | `openingHours.allDaysOpeningHours` | as above | 2026-10-05T01:37:14Z |
| `pickup.available`, `pickup.estimated_minutes` | `serviceMethods (pickup)`, `takeAwayTime` | as above | 2026-10-05T01:37:14Z |
| `delivery.areas` → **UNKNOWN** | `deliveryMode` | `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/families/by-domain?domain=pizzaepasta-ruedesheimerplatz.de` | 2026-10-05T01:37:14Z |

**This run could not re-fetch the pizza rail.** A plain HTTPS GET is answered
with the Cloudflare challenge, and the committed cookie jar does not lift it:

```
2026-10-09T23:37:44Z  myrestaurant-restaurant      HTTP 403   (plain GET, desktop UA)
2026-10-09T23:37:44Z  myrestaurant-family          HTTP 403
2026-10-09T23:38:03Z  myrestaurant-restaurant      HTTP 403   (with evidence/cookies.json jar)
2026-10-09T23:38:03Z  myrestaurant-family          HTTP 403
```

So pizza's declared facts rest on the committed 2026-10-05 capture
(`evidence/requests.json` + `venues/pizza-e-pasta-ruedesheimerplatz/evidence/raw/`),
not on a fresh read. They are **not** stale-verified. The 403 is recorded in
`recheck-t7d410f66/` (`RECHECK.md`, `pizza.*.sha256`).

What the pizza republish changes on the wire is therefore small and only about
honesty of the *shape*: the delivery block gains explicit `null`s
(`area_mode`, `zones`, `areas_retracted`) next to the existing `areas_named:
null` and the `areas_note`, so a client can tell "this venue does not assert an
area" from "this field is absent". No area is invented.

## 3. Fields that were NOT verifiable from the rail (explicit list)

Taken from each venue record's own `provenance.not_verifiable_from_rail`, with
this run's verification status:

- doppelt: **which postcodes are served** — the rail exposes no postcode list and
  no per-address deliverability endpoint (`delivery.area_selector_url` is null).
- doppelt: **which addresses inside the 5000 m circle are actually served** —
  the rail publishes the geometry only.
- doppelt: the storefront's **named district list** — retracted, not a fact of
  this venue (`delivery.areas_retracted`).
- pizza: **delivery postcodes / areas** — `deliveryMode=PostCode`, the
  platform resolves deliverability server-side; the route that would answer it
  is behind the origin's Cloudflare challenge (HTTP 403). Recorded as
  `delivery.areas` status **UNKNOWN**; announced as `null`, not as a guess.
- pizza: **whether a specific address is inside the area** — only the venue's own
  shop can answer that, at order time.
- pizza: **per-area delivery fee / minimum order** — the payload carries one
  value for the whole restaurant; no per-area variant exists, so none is claimed.
- pizza (added by this run): the pizza rail itself **could not be re-read at all**
  (HTTP 403), so *none* of pizza's fields are freshness-verified — see §2.2.

## 4. Republished events and read-back proof

Authoritative table: `live-after-t7d410f66/TABLE.md` (generated). Both announced
relays — `wss://relay2.orangesync.tech` and `wss://relay.primal.net` — were read
before and after and returned the same single event per (venue, kind).

| venue | kind | before (relay id) | after (relay id) | changed |
|---|---|---|---|---|
| doppelt-kaese-berlin | 11316 | `12ee1fdbc200243c…` | `12ee1fdbc200243c891932b6e9751d21948ae126e13088aee2ab7504532beb34` | no (published earlier in this card) |
| doppelt-kaese-berlin | 11317 | `7b6a4010412b2765…` | `7b6a4010412b2765af09c9df7f0248702d8dc358f7571a9989be0b171d5148e1` | **no republish needed** |
| pizza-e-pasta-ruedesheimerplatz | 11316 | `a41f4e5c596a9037…` | `d58b21fbc10232a84d816de953aad31d608051b66776679eeb14a39bfb116d39` | **YES — republished by this run** |
| pizza-e-pasta-ruedesheimerplatz | 11317 | `ace6d6ec802c5a08…` | `ace6d6ec802c5a080352698a8d01774b66c710427964b510151cb2bdfd0cf1f1` | **no republish needed** |

- Both events were signed by the venue's **own** key: doppelt
  `fe700a09…98984` (service npub `npub1lecq5zg…`), pizza `ef070a5d…1ea2b`
  (service npub `npub1aurs5hw…`). Kinds 11316/11317 are NIP-16 replaceable, keyed
  by (kind, pubkey), so a republish by the venue's key **replaces** the venue's
  announcement rather than forking it.
- Verified: `live-after-t7d410f66/VERIFY.txt` (live event == what the tree's
  emitter produces, content AND tags, for all four events, both relays) and
  `regen-check.sh` (committed artifacts == fresh `--dry-run`, all four).
- The live before/after diff is `LIVE-DIFF-t7d410f66.md`; the artifact-level
  before/after diff for both venues is `DIFF-t7d410f66.md` (pre-existing, this
  card) — it compares the pre-card committed artifacts, which predate the
  ADR-0011 order-input drift, so for the two kind-11317 events it shows drift
  that the relays had **already** carried. §4's table is the state of the relays.

**No republish for doppelt 11317 / pizza 11317** was deliberate: their live
content already equals the emitter's output, so republishing would only churn
`created_at` and the event id without changing a byte of what clients read.

## 5. Tooling defect found and fixed (why the first attempt died)

The first attempt on this card published doppelt 11316 and then hung: the
emitter's `publish()` opened a WebSocket, resolved on the relay's `OK`, and never
closed it, so the Deno event loop never drained and the CLI could not exit. That
run was killed on the box (SIGTERM, 2026-10-10 00:57, ~28 min) with part of its
republish evidence half written; this run's first publish reproduced the hang
(the relay had already accepted both events, the command still had to be killed).

Fix: `tools/nostr.ts` — close the socket on every exit path (OK, OK-timeout,
connect failure). Evidence:

- `RED-publish-socket-hang.txt` — the new test against the unfixed tree:
  `FAILED (5s) … publish() left the socket open - TIMEOUT: socket still open 5s after OK`.
- `tools/nostr_publish_test.ts` — GREEN after the fix, observations made through
  a local relay's close event (`deno test --allow-read --allow-net`).
- `emit-exit-proof.txt` — the real CLI pointed at a local accept-all relay:
  `exit_code: 0`, `wall_seconds: 11.2` (no kill needed). No real relay is written
  to by that proof; it uses a throwaway key and a dummy event.
- Suite: `deno task test` → **82 passed | 0 failed | 1 ignored**;
  `deno task test:net` → **83 passed | 0 failed** (`test-net.txt`), including the
  real relay2 publish→read-back.

## 6. Files in this directory (card t_7d410f66)

| file | what it proves |
|---|---|
| `fetch-live-announcements.sh` | read-back both relays, per venue+kind |
| `live-before-t7d410f66/`, `live-after-t7d410f66/` | the raw readbacks; `VERIFY.txt`, `TABLE.md` generated from them |
| `compare-live-vs-artifacts.py` | live == emitter artifact, per event; relays agree |
| `live-table.py` | the authoritative id table (+ content sha256) |
| `gen-live-diff.py` → `LIVE-DIFF-t7d410f66.md` | the diff the relays actually saw |
| `regen-check.sh` | committed dry-run artifacts == fresh regeneration |
| `recheck_rail.py`, `recheck-t7d410f66/` | re-fetch the rails, compare payload sha256 |
| `recheck_pizza_with_cookies.py` | retry pizza with the committed cf jar (still 403) |
| `recheck-doppelt-radius.py` | independent circle-vs-district recomputation |
| `publish-pizza-11316.sh` | the republish (key read from the 0600 file into a 0600 temp file; never on a command line) |
| `published-t7d410f66/` | the signed events as published + each relay's OK/REJECT verdict |
| `DIFF-t7d410f66.md` | pre-existing artifact-level before/after diff (both venues, both kinds) |
| `RED-publish-socket-hang.txt`, `emit-exit-proof.txt`, `test-net.txt` | the tooling fix |

## 7. How to reproduce (from the worktree root)

```
evidence/announcements/fetch-live-announcements.sh live-after-t7d410f66   # read the relays
python3 evidence/announcements/compare-live-vs-artifacts.py live-after-t7d410f66
python3 evidence/announcements/regen-check.sh /tmp/regen                 # artifacts are current
python3 evidence/announcements/recheck_rail.py recheck-t7d410f66         # rails: doppelt 200/match, pizza 403
python3 evidence/announcements/recheck-doppelt-radius.py                 # 11 of 15 outside
```

(`recheck_rail.py` exits non-zero when a rail cannot be matched — that is the
pizza 403, not a flake. It is reported, not hidden.)
