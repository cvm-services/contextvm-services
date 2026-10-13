# PROVENANCE — ristorante-matera-berlin

Built 2026-10-13 on x280 by the manager profile (fleet worker), after three
delegated builds were lost to gateway instability (documented in the session
notes; nothing of theirs was committed).

## Calls

| file | URL | when (UTC) |
|------|-----|------------|
| `franchise.json` | `https://app.foodamigos.io/api/franchises?hostname=restaurant-matera.de` | 2026-10-13 ~14:10 |
| `menus.json` | `https://app.foodamigos.io/api/companies/1742/menus` | 2026-10-13 ~14:10 |

Both are the venue's own public, unauthenticated JSON API (FoodAmigos
storefront platform), fetched with the adapter UA string.

## Redactions applied to `franchise.json`

Dropped entirely (never entered the repo):
`data.companies[0].service_provider` (contains stripe_key, adyen_key,
mixpanel_api_key, amplitude_api_key, platform_mixpanel_token, sender_email,
support_email), `stripe_id`, `stripe_excluded_payment_method_types`,
`stripe_hideable_payment_method_types`, `stripe_platform_payment_methods`,
`payment_gateways`, `paypal_standalone`, `data.head_scripts`,
`data.body_noscripts`.

Kept (public venue facts, same as the storefront shows): name, address,
lat/lon, phone (+49 30 60927677 — the restaurant's public business number),
work schedule, cuisine, ratings, pickup/delivery flags, web_shop_url.

The residual string `"payment_gateway": "adyen"` is the platform *name* field
(non-secret, public in the storefront bundle), not a credential.

`menus.json` needed no redaction (menu/categories/products/modifier groups
only — no owner or credential fields; verified by scan).

## Price integrity

Every price in `venue.json` is `base_price` (or `order_method_prices` where
set) from `evidence/menus.json`. Nothing inferred, rounded, or invented.
The rendered-page price anchor used by three-buddies-berlin was **not**
reproducible here (shop page HTTP 429 from the build host) — see README
"Honest limitations".

## Verification performed

- `adapter.py --selftest`: item count in range, price range present, company
  binding match, Italian-menu spot-check, deterministic double-build — PASS
- leak-guard scan of both evidence files for
  stripe/adyen-key/mixpanel/api_key/owner_email/owner_phone/sender_email —
  only the benign `payment_gateway: "adyen"` name remains
- `venue.json` rebuild == committed (hash-stable)
