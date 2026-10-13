# ristorante-matera-berlin

Normalised venue record for **Ristorante Matera**, Birkbuschstraße 7, 12165
Berlin (**Ortsteil Steglitz**) — Italian restaurant (pizza/pasta).
Built 2026-10-13 from the venue's own public FoodAmigos JSON API.

- `venue.json` — the record (`schema: cvm.venue/v1`)
- `adapter.py` — fetches the venue's own API and produces it
- `evidence/` — the raw (redacted) API responses the record was built from

## Why this venue

Second FoodAmigos venue inside Steglitz proper (Birkbuschstraße), giving the
Lightning-pickup pilot a lunch-option alternative to Three Buddies
(Albrechtstraße) and La Mama. Verified live at build time: `is_live=true`,
`has_pickup=true`, `open_now_for_pickup=true`, Google 4.6★ (255 ratings),
phone +49 30 60927677.

## Build chain (both calls plain unauthenticated GETs)

1. `GET https://app.foodamigos.io/api/franchises?hostname=restaurant-matera.de`
   → franchise 1684 (`ristorantematera`), companies[0].id **1742**
2. `GET https://app.foodamigos.io/api/companies/1742/menus`
   → 2 menus / 13 categories / 103 products / 4 modifier groups

**No company-id trap** for this venue (unlike three-buddies-berlin's 509/550):
the franchise chain resolves company 1742, and 1742's menu is the Italian menu
this restaurant serves (spot-check: "Acqua Panna", "Tagesmenü", pizza/pasta
names). Recorded in `venue.company_binding`.

## Honest limitations

- **No page-price anchor.** The rendered shop
  (`ristorantematera.online-karte.com`) returned HTTP 429 from the build host,
  so prices could not be cross-checked against the rendered page as
  three-buddies-berlin does. Prices are anchored to the committed
  `evidence/menus.json` (the venue's own API) instead. If a rendered-page
  capture becomes possible later, add the anchor per the three-buddies adapter.
- `captured_at` reflects the build time when the API response carries none.

## Redaction

Owner identity, payment-provider keys, analytics tokens and support emails are
dropped from `evidence/franchise.json` before commit (leak-guarded at build:
`service_provider`, `stripe_*`, `payment_gateways`, `paypal_standalone`,
`business_owners`, `head_scripts`, `body_noscripts`). The string
`"payment_gateway": "adyen"` that remains is the platform name, not a key.

## Usage

```bash
python3 adapter.py --fetch     # re-fetch evidence from the network
python3 adapter.py --selftest  # invariants + determinism
python3 adapter.py             # rebuild venue.json from evidence
```
