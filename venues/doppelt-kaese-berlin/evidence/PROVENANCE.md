# Provenance — doppelt-kaese-berlin

Retrieved **2026-10-05** from the venue's own public JSON API (FoodAmigos
storefront). Plain HTTPS GET, no authentication, no OCR, no HTML scraping.

## Source calls

| # | URL | bytes | sha256 as fetched (unredacted) | sha256 of committed copy |
|---|-----|-------|-------------------------------|--------------------------|
| 1 | `https://www.doppelt-kaese-berlin.de/api/store` | 55072 | `a6ca1f2bcc1ae0ddd71a08e1f30db3b3d8148af9e9f897a85107e101d41d6f0b` | `bfb5f48a072477f96162f1f0018a1846aabb0e4a5ee14395c1749a6a98c4a9f5` |
| 2 | `https://app.foodamigos.io/api/companies/doppeltkase/data?hostname=doppelt-kaese-berlin.de` | 10428 | `5cc4090d8d5d9e0d2d193a4c5b68c4c7c72f52f3fa288f0693377df16359167f` | `8cfe0b7d5c9868f2a7ce599c35053bf790a8f40f624f209eb0f75e4085dd6894` |
| 3 | `https://app.foodamigos.io/api/companies/1387/menus` | 123598 | `8a7f2e4e6af58cab05ce9e375d7cf4c5085a3e4fb3dcfa7ed86e61b39ec15cd5` | `a6bd6bdc8eb7e2a2a3ff7f24ca54b94b797d09fc831dbba8237fb5e177584791` |

Verify the committed copies without re-fetching anything:

```bash
cd venues/doppelt-kaese-berlin
sha256sum -c <<'EOF'
bfb5f48a072477f96162f1f0018a1846aabb0e4a5ee14395c1749a6a98c4a9f5  evidence/raw/store.json
8cfe0b7d5c9868f2a7ce599c35053bf790a8f40f624f209eb0f75e4085dd6894  evidence/raw/company.json
a6bd6bdc8eb7e2a2a3ff7f24ca54b94b797d09fc831dbba8237fb5e177584791  evidence/raw/menus.json
EOF
```

Call 1 also confirms the storefront payload (`id 1157`, `franchise_slug
doppeltkase`) and calls 2–3 resolve the company (`id 1387`) from it. The call
chain is recorded in `evidence/requests.json`, produced by a headed browser on
the venue's ordering route (`evidence/capture-menu-requests.py`).

## Committed evidence files

```
evidence/raw/store.json          canonical copy of call 1   (redacted)
evidence/raw/company.json        canonical copy of call 2   (redacted)
evidence/raw/menus.json          canonical copy of call 3   (no redaction needed)
evidence/raw/_provenance.json    urls + sizes + sha256 of the responses as fetched
evidence/fragments/*.txt         verbatim byte-slices of the above (readable in the PR)
evidence/rendered-ordering-page.txt  text a real browser rendered on the ordering page
evidence/requests.json           every xhr/fetch the ordering route made
```

Evidence files are written with `json.dumps(..., indent=2, sort_keys=True)` plus a
trailing newline, so a re-fetch produces identical bytes when the venue's data has
not changed.

## Redaction

The venue facts published here are the restaurant's own public data (address,
hours, menu, prices). These fields are **not** republished and are replaced with
the string `[REDACTED]` in the committed copies:

`evidence/raw/store.json`
- `data.impressums[*].owner`, `.email`, `.phone_number`
- `data.business_owners`
- `data.google_cloud.api_key`
- `data.service_provider.mixpanel_api_key`, `.notification_channels`
- `data.companies[*].google_reviews` (third-party review authors)

`evidence/raw/company.json`
- `company.email`, `company.business_profile.owner_*`, `company.impressum.owner_*`
- `company.service_provider.stripe_key`, `.adyen_key`, `.mixpanel_api_key`,
  `.amplitude_api_key`, `.platform_mixpanel_token`, `.google_analytics_id`,
  `.sender_email`, `.support_email`, `.otp_delivery_channels`

`evidence/raw/menus.json` contains no PII — committed verbatim.

The `sha256` values above are of the **unredacted** responses, so provenance
remains checkable by anyone who re-fetches. The adapter refuses to write a
fragment that would contain `@`, `owner_`, `stripe_key`, `adyen_key` or
`notification_channels` (`PII_GUARD` in `adapter.py`), which turns a redaction
regression into a build failure rather than a leak.

## What the prices came from

`venue.json.menu.items[*].price` is `products[*].base_price` from call 3;
`prices_by_order_method` is that product's `order_method_prices` object. Both are
copied, never computed. The companion file `evidence/fragments/menus.product.fragment.txt`
shows one such object verbatim, and `adapter.py --verify-rendered` proves the same
numbers appear on the venue's rendered ordering page.
