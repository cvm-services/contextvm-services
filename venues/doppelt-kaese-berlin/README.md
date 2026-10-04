# doppelt-kaese-berlin

Normalised venue record for **doppelt Käse**, Laubacher Straße 11, 14197 Berlin
(Wilmersdorf) — a burger restaurant. Generated 2026-10-05.

- `venue.json` — the record (`schema: cvm.venue/v1`)
- `adapter.py` — fetches the venue's own API and produces it
- `evidence/` — what the record was built from (see `evidence/PROVENANCE.md`)

## The problem this adapter solves

The public site is a FoodAmigos "storefront" React app:

- `GET https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase` returns a
  ~2 KB HTML shell. **Zero prices in the served HTML.**
- The Next.js flight payload carries page/company content and `menu_items` with
  CloudFront image URLs — still **no price fields**.

The prices only exist in a client-side JSON call. `evidence/capture-menu-requests.py`
runs a headed browser on the ordering route and records every request it makes.
Exactly three of them carry the venue record, and all three answer plain
unauthenticated GETs:

| call | gives |
|------|-------|
| `GET www.doppelt-kaese-berlin.de/api/store` | storefront payload: name, address, `franchise_slug`, region, named delivery areas |
| `GET app.foodamigos.io/api/companies/doppeltkase/data?hostname=…` | company `1387`: lat/lon, legal address, work schedule, delivery zones |
| `GET app.foodamigos.io/api/companies/1387/menus` | menus, categories, **products with `base_price` + `order_method_prices`**, modifier groups, allergens/additives |

`adapter.py` therefore needs no browser and no OCR: it re-fetches those three
URLs and normalises them. The browser is only needed as evidence of *how the
source was found*.

## Run it

```bash
python3 adapter.py                 # build from committed evidence (fetch if absent)
python3 adapter.py --fetch         # force a fresh fetch from the venue
python3 adapter.py --selftest      # determinism + invariants
python3 adapter.py --check         # rebuild, compare byte-for-byte with venue.json
python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
```

`--verify-rendered` is the independent check: it parses the prices out of the
*text a real browser rendered* and asserts they equal the API-derived prices in
`venue.json`. If the adapter ever mis-reads the JSON, this fails.

## Relationship to the specs

- `vocab/service-inputs.json` fixes the vocabulary a *provider announces*
  (`order.fulfilment` ∈ `pickup | delivery | dine_in`). This record is the other
  side — the venue's own content — but it uses the same words:
  `venue.order_methods` and the `prices_by_order_method` keys are copied verbatim
  from the venue API and already read `pickup` / `delivery` / `dine_in`.
- Nothing here publishes an announcement yet. `venue.json` is the input a
  CEP-0001 provider would build its `cap` prices and `t`/`g` tags from; no
  `cvm:*` tags, no `cap`, therefore `source.settlement.cvm_cap: null` — a price
  the venue cannot honour is worse than no advertised price (P4).

## What was verified (2026-10-05, see PROVENANCE.md for hashes)

- 9 menu sections, 76 items on the ordering page, **76/76 carrying a price**,
  currency EUR, 0.50 – 13.00.
- 0 price mismatches against the browser-rendered page (61/61 item rows matched).
- A second full re-fetch produced a **byte-identical** `venue.json`.

## Known gaps (not defects — say them out loud)

- 11 further products are returned by the API for this company but are attached
  to no rendered section (their categories are absent from the payload and never
  appear on the ordering page). They are kept under `menu.unlisted_items`
  (priced, `listed_in_menu: false`) and excluded from `menu.stats` totals.
- Each product is listed in **several** sections, so section item counts overlap;
  `menu.items` is the deduplicated union.
- `base_price` is the dine-in price; `prices_by_order_method.pickup` is the
  10 %-discounted pickup price the storefront displays alongside it.
- Delivery is `mode: external` (zone: circle, 5 000 m, fee 5.00, min order 20.00).
  No delivery-fee/min-order is asserted per item by the venue API.
- The platform's own shop (`doppeltkase.online-karte.com`) rate-limited this
  host (HTTP 429) during recon; the venue's own domain worked. Not needed by the
  adapter.
