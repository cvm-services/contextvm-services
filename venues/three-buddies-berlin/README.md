# three-buddies-berlin

Normalised venue record for **Three Buddies Steglitz**, Albrechtstraße 131,
12167 Berlin (**Ortsteil Steglitz**) — a burger / Italian-American restaurant.
Generated 2026-10-11.

- `venue.json` — the record (`schema: cvm.venue/v1`)
- `adapter.py` — fetches the venue's own API and produces it
- `evidence/` — what the record was built from (see `evidence/PROVENANCE.md`)

## The problem this adapter solves

The public site is the same FoodAmigos "storefront" React app as
`doppelt-kaese-berlin`:

- `GET https://www.threebuddies.de/speisekarte/threebuddies` returns an HTML shell
  with **zero prices**; the menu is fetched client-side.
- So the prices exist only in JSON the browser asks for. `evidence/capture-menu-requests.py`
  runs a headed browser on the venue's own ordering route and records every request.
  Three of the calls it makes carry the venue record, and all three answer plain
  unauthenticated GETs:

| call | gives |
|------|-------|
| `GET https://www.threebuddies.de/api/store` | storefront payload: store `481`, name, address, `quarter` (Steglitz), `franchise_slug`, `has_pickup`/`has_delivery`, `companies[*]` → company `509` |
| `GET https://app.foodamigos.io/api/companies/threebuddies/data?hostname=www.threebuddies.de` | company `550`: lat/lon, legal address, work schedule, delivery zones, payment gateways |
| `GET https://app.foodamigos.io/api/companies/550/menus` | menus, categories, **products with `base_price` + `order_method_prices`**, modifier groups, allergens/additives |

`adapter.py` therefore needs no browser and no OCR: it re-fetches those three URLs
and normalises them. The browser is only evidence of *how the source was found*.

### Which storefront host

`https://threebuddies.de/api/store` answers **HTTP 308** and redirects to
`https://www.threebuddies.de/api/store`, which is the URL the adapter uses (it is
the request the venue's own ordering page makes, see `evidence/requests.json`).
The platform mirror `https://storefront.foodamigos.io/api/stores/threebuddies.de`
returns the same payload and is recorded in `source.calls.store.storefront_mirror_url`
for reference; it is never read for the build.

### The company-id trap this venue sets

The storefront payload binds store `481` to company **509**. The
franchise-level company payload returns company **550**. **Both ids answer
`/menus` with HTTP 200**, and company 509's menu is a different, non-burger menu
this venue does not serve. A naive "use the id from the store" adapter would
publish the wrong menu with a straight face.

The browser capture is the tie-breaker and is committed as evidence: the venue's
own ordering page requests `/api/companies/550/menus`, and the prices it renders
match 550's `base_price`/`order_method_prices` (the `--verify-rendered` /
`--anchor` checks below, 61/61 rows). This adapter follows the platform's own
chain — store → `franchise_slug` → `/companies/<slug>/data` → `company.id` (= 550)
→ `/menus` — and records the disagreement in
`venue.company_binding` rather than hiding it.

## Run it

```bash
python3 adapter.py                      # build from committed evidence (fetch if absent)
python3 adapter.py --fetch              # force a fresh fetch from the venue
python3 adapter.py --selftest           # determinism + invariants (+ scrub/R1 regressions)
python3 adapter.py --check              # rebuild, compare byte-for-byte with venue.json
python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
python3 adapter.py --write-anchor evidence/anchor/page-price-anchor.json
python3 adapter.py --anchor evidence/anchor/page-price-anchor.json
python3 adapter.py --negative-test      # perturb a price; require the anchor check to FAIL
```

### The verification is not circular

A cold review of a sibling PR found an "e2e" that derived its expectation from the
artefact under test (a fabricated venue passed 41/0). Both checks here compare the
record against the venue's **own page**, which `venue.json` was not built from:

- `evidence/anchor/page-price-anchor.json` is a committed expectation file of 61
  item name → price pairs **read out of the text a real browser rendered** on
  `https://www.threebuddies.de/speisekarte/threebuddies` (Abholung column).
  `--anchor` compares every entry against `venue.json`; a name that is missing, a
  price that differs, or fewer than 10 matches all fail (a vacuous pass is a
  failure by construction).
- `--verify-rendered` parses the same page dump with an independent code path
  instead of reading the anchor file.

`--negative-test` is the proof the check is live: it perturbs one anchored price
by +1.00 EUR in an in-memory copy and requires the check to fail. It does:

```
NEGATIVE TEST: perturbed 'Blue Cheese Burger' to 9.90 EUR in an in-memory copy (the committed record is untouched)
  check_anchor on the perturbed copy -> exit 1
  PERTURBED-FAILURE: 'Blue Cheese Burger': venue.json=9.9 page=8.90
NEGATIVE TEST OK — the check fails when a price is perturbed (a vacuous check would have passed)
```

## Service methods

Both, from the venue's own payloads:

- **pickup** — `has_pickup: true`, prep `10` min; the price column the storefront
  renders by default and therefore the column this record is checked against.
- **delivery** — `has_delivery: true`, `mode: external`, one circle zone
  (`Uber delivery`, 5 000 m, fee 5.00, min order 20.00, max 750.00), estimated
  30 min.

Opening hours: **12:00–21:30 Tuesday to Sunday, closed Monday** (work schedule in
`venue.opening_hours`; Monday is absent from the source, so the record says
nothing about Monday rather than inventing "closed").

## Adapter class (ADR-0007) — stated honestly

```json
"adapter": { "class": "deep_link_human",
             "capabilities": { "menu": true, "quote": true, "submit": false, "status": false } }
```

**The platform does run an online shop for this venue** (`threebuddies.online-karte.com`,
Stripe/Google-Pay material loaded on the ordering page). That is *not* the same as
being able to place an order from here, and ADR-0007 requires REJECT over silent
degrade:

- no unauthenticated or test-mode path to place an order was found or verified;
  the cart and checkout are authenticated, session-bound browser flows;
- clicking **Lieferung** on the storefront opens a delivery-address modal (the
  capture shows the overlay intercepting the click), so even reading the delivery
  column needs a human;
- so the CVM returns a basket + the venue's own deep link and a human completes
  checkout on the venue's rail. `submit` and `status` are `false`.

`venue.settlement.rail` is the venue's own rail (adyen, stripe; accepts
apple_pay, google_pay, card, pay_by_bank, paypal, cash) and `cvm_cap` is `null`:
no CVM call is priced, and a price the venue cannot honour is worse than no
advertised price (ADR-0008, P4). Nothing here weakens ADR-0008 — the rail verdict
is still what makes an order paid.

## Relationship to the specs

`venue.json` is the **catalog record** (`slug` / `source` / `venue` / `menu`) and
stops there. It carries **no announce tags** — not `cvm:service:*`, not
`cvm:req:*`/`cvm:opt:*`, and not `cvm:tier:*`. Emitting those is the announce
emitter's job (`tools/emit-venue-announcement.ts`), which owns the final field
list and therefore the tier it must recompute (CEP-0001 P2a). Two seams matter
when it consumes this record:

- `order_methods` and the `prices_by_order_method` keys are copied verbatim from
  the venue API and already read `pickup` / `delivery` / `dine_in`.
- `settlement.cvm_cap` is `null` (see above).

## What was verified (2026-10-11, hashes in PROVENANCE.md)

- 12 menu sections, 1 menu, **100 items on the ordering page, 100/100 carrying a
  price**, currency EUR, **1.50 – 17.40**.
- **61/61** browser-rendered item rows matched the record: 0 mismatches
  (`--anchor` and `--verify-rendered`).
- The perturbed-price negative test **fails** the check, as it must.
- A second full re-fetch produced a **byte-identical** `venue.json`
  (`--check`, sha256 `3a662c23a7a563f6cd8f15e5151ee11389cc02658add630f9c13379d32be7f14`).
- The redaction guard proves the **email** in the payload (it sits inside a
  franchise pitch in prose, not only in a named field) and every non-published
  phone number are gone from the committed copies, while the venue's own business
  phone survives; the store UUID is not mangled by the scrubber.

## Known gaps (not defects — say them out loud)

- 22 further products are returned by the API for this company but attached to no
  rendered section (their categories are absent from the menus payload and never
  appear on the ordering page). They are kept under `menu.unlisted_items`
  (priced, `listed_in_menu: false`) and excluded from `menu.stats` totals.
- Each product is listed in **several** sections, so section item counts overlap;
  `menu.items` is the deduplicated union.
- **The page renders one price column at a time.** Only the default Abholung
  (pickup) column could be captured, so the page anchor covers pickup. Delivery
  prices come from the venue's JSON only (`order_method_prices.delivery`), and are
  *not* independently page-verified — the `Lieferung` tab opens an address modal
  that blocks the capture. Recorded rather than papered over.
- The platform returns a **masked** company phone (only its first and last four
  digits are visible — unusable as a contact, so it is not reproduced here); the
  adapter treats a masked value as absent and publishes the venue's real business
  number from the storefront payload instead. The record is never allowed to carry
  a masked or redacted placeholder (asserted in `run()`).
- `google_rating` is 4.3 as expected; the payload's review count is **163**, while
  the platform's own display record said 148. The record publishes what the source
  says and the divergence is noted here rather than reconciled by hand.
- Company 509 is what the storefront payload binds store 481 to; company 550 is
  what the venue's ordering page loads. See `venue.company_binding`.
- 55 of 100 items carry modifier groups (20 option groups; each option's own
  `base_price` is carried, e.g. an extra Patty at 3.50). The record lists the
  groups and options but does not compute a basket total (that is a CVM-time
  concern, not a catalog one). 91 items carry allergens/additives.
