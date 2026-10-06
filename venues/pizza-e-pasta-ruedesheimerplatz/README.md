# pizza-e-pasta-ruedesheimerplatz

Normalised venue record for **Pizza e Pasta**, Rüdesheimer Str. 9, 14197 Berlin
(Wilmersdorf) — an Italian pizza/pasta restaurant. Generated 2026-10-05.

- `venue.json` — the record (`schema: cvm.venue/v1`)
- `adapter.py` — turns the venue's own API payloads into it
- `evidence/` — what the record was built from (see `evidence/PROVENANCE.md`)

## The platform, and the problem this adapter solves

The venue runs its **own** ordering rail at
<https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway> — an
**OrderYoyo** shop (API namespace `/oyy-api`, hosts under `orderyoyo.com`; the
restaurant record self-identifies as `externalRPId: "AppSmart_8871"`, i.e. the
platform's "order smart"/AppSmart product, and its imprint address sits under
`kontakt-ordersmart.de`).  There is no third-party marketplace in the loop; the
record's deep-link target is the venue's own page.

Two obstacles:

1. **The origin is behind a Cloudflare managed challenge.**  `HTTP 403`
   (`cf-mitigated: challenge`, "Just a moment…") for everything — plain curl,
   curl with a desktop UA, and even curl carrying the successful run's
   `cf_clearance` cookie (the clearance is bound to the browser's TLS
   fingerprint).  A headed Chrome under xvfb passes it — once, on a fresh
   profile; afterwards the IP goes into a sticky cooldown.  Measured outcome and
   the exact recovery procedure: `evidence/PROVENANCE.md`.
2. **The menu is not a scrapeable HTML table.**  It is server-side rendered
   *from the platform's JSON API*, and the `HTTP 200` page embeds those exact
   responses in `__NEXT_DATA__.props.pageProps.initialData.fallback`.  Five
   payloads carry the whole record:

   | call | gives |
   |------|-------|
   | `GET /oyy-api/MyRestaurant/families/by-domain/restaurants?domain=…` | the family's restaurants: address, lat/lon, opening hours, service methods, delivery mode, fees |
   | `GET /oyy-api/MyRestaurant/restaurant/45842?timeSensitive=false` | that restaurant in detail (same shape + ids, vat, imprint) |
   | `GET /oyy-api/MyRestaurant/families/by-domain?domain=…` | family/brand record (theme, logos, published-app links) |
   | `GET /oyy-api/MyMenuManagementSystem/restaurants/45842/menu?version=9&type=Takeaway` | categories, **items with `price`/`priceLevel1`/`priceLevel2` and their `discounted*` twins**, addons, allergens, flags, tax bands |
   | `GET /oyy-api/AppPublishing/families/14842/published-apps` | the family's own iOS/Android app links |

So the adapter needs **no browser, no OCR and no HTML parsing**: it reads the
committed payloads (or re-extracts them from a captured page) and normalises them.

## Run it

```bash
python3 adapter.py                                        # build venue.json from committed evidence
python3 adapter.py --check                                # rebuild, compare byte-for-byte
python3 adapter.py --selftest                             # determinism + invariants
python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
python3 adapter.py --ingest-page /path/to/captured-page.html   # re-extract evidence
python3 adapter.py --fetch                                # drive the browser capture for a fresh page
```

`--fetch` shells out to `evidence/capture-menu-requests.py`, which needs
`xvfb-run`, Chrome and Playwright, makes **at most 3** attempts and then stops.
`--check` and `--selftest` never touch the network.

## What was verified (2026-10-05; hashes in PROVENANCE.md)

- **9 real sections + 1 platform "most popular" view**, **112 distinct products,
  112/112 priced**, EUR, 2.70 – 16.65.
- **112/112** items cross-checked against the *text a real browser rendered* on
  the ordering page (`--verify-rendered`): the payable price **and** the list
  price agree on every row, 0 mismatches.
- A rebuild from the committed evidence is **byte-identical** (`--check` MATCH,
  sha256 `a47b20fc…`), and the build is deterministic (`--selftest`).

## How prices are read (copied, never computed)

- The menu is fetched with `type=Takeaway` (the venue's takeaway page), so every
  price is the **pickup/takeaway** price and carries the venue's own 10 % discount:
  `price` is copied from `discountedPrice*`, `list_price` from the matching
  undiscounted field, `discount_percent` from `discount`.  Nothing is recomputed.
- The platform numbers a required "Deine Größe" (`PriceLevelEnum`) addon by option
  order — `orderBy 1 → priceLevel1`, `orderBy 2 → priceLevel2` — and the ordering
  page pre-selects the **first** option.  So the level the venue displays (and this
  record keeps) is the lowest defined level: pizzas define only level 2 (their
  single "Ø 32cm" size), the two bottle wines define both and show level 1
  ("0,75l" — the size their own title names).  `price_levels` keeps every level the
  payload declares, and `price_level_used` says which one `price`/`list_price` came
  from.  This rule is what `--verify-rendered` proves against the live page.

## Relationship to the specs

`venue.json` is the **catalog record** (`slug` / `source` / `venue` / `menu`) and
stops there — it carries **no announce tags** (no `cvm:service:*`, no
`cvm:req:*`/`cvm:opt:*`, no `cvm:tier:*`).  Emitting those is the announce
emitter's job (`cvm-service-kit`, S2a), which owns the field list and therefore the
tier it must recompute.  As in S1a, `source.settlement.cvm_cap` is `null`: no CVM
call is priced yet, and advertising a price the venue cannot honour is worse than
advertising none.

`venue.order_methods` uses the vocabulary fixed by `vocab/service-inputs.json`
(`pickup` / `delivery`); the source's `Pickup`/`Delivery` are mapped, and the
menu's own `service_method` is `pickup` (see above).

## Known gaps (not defects — said out loud)

- **Delivery area is postcode-based and not captured.** `deliveryMode=PostCode`;
  the platform resolves deliverability server-side via
  `/oyy-api/MyRestaurant/restaurant/45842/delivery-area` (route name found in the
  frontend bundle).  That endpoint answered the Cloudflare challenge in every later
  attempt, so `venue.delivery.areas` is **empty** rather than invented; the reason
  and the endpoint name are recorded in `venue.delivery.area_note`.
- **Only the takeaway menu is asserted.** The pickup payload is what the venue's
  own takeaway page serves; delivery is a separate menu variant (`type=Delivery`)
  that was not captured.  Prices are therefore labelled `service_method: pickup`,
  not presented as universal.
- **`todayOpeningHours` / `todayDeliveryHours` are not used.** The page requests
  the restaurant endpoint with `timeSensitive=false`, so those fields are pinned to
  the last time-sensitive render (they still said "Friday" on a Monday capture).
  Only `allDays*` drives `venue.opening_hours`, which carries all seven weekdays.
- **Three article numbers are duplicated in the source** (`110`, `36`, `44` — two
  products each, e.g. `Pizza Sardelle` / `Pizza Picante (scharf)`).  Kept as
  published; reported under `menu.stats.duplicate_skus`.
- **No cuisine list** is declared by the venue API, so `venue.cuisine` is absent
  rather than guessed.  `venue.food_flags` / `dietary_attributes` come straight from
  the payload's `menuFlags` (`Vegan`, `Food for adult 18+`).
- **The "most popular" view overlaps real sections.**  Section `9999`
  (`kind: popular_view`) repeats ten product ids that also live in their own
  sections, so `menu.items` is the deduplicated union and section item counts
  overlap — never sum them.  `stats.sections` counts real sections only.
- **Option groups are de-duplicated with variants.**  The platform re-declares the
  same group id with *different* option prices at category and item level, so ids
  are suffixed (`4454494`, `4454494-2`, …) and each item points at the variant that
  actually applies to it; `source_group_id` keeps the original.
- `evidence/page.html` (the 726 kB HTTP 200 page) is **not committed** — it is a
  third-party document containing a contact e-mail.  Its sha256 is recorded instead;
  `evidence/.gitignore` keeps a re-captured copy out of git.
