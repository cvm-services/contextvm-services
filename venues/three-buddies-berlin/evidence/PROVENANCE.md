# Provenance — three-buddies-berlin

Retrieved **2026-10-11** from the venue's own public JSON API (FoodAmigos
storefront). Plain HTTPS GET with an identifying User-Agent, no authentication,
no OCR, no HTML scraping:

```
User-Agent: cvm-services-venue-adapter/1.0 (+https://github.com/cvm-services/contextvm-services)
```

## Source calls

| # | URL | bytes | sha256 as fetched (unredacted) | sha256 of committed copy |
|---|-----|-------|-------------------------------|--------------------------|
| 1 | `https://www.threebuddies.de/api/store` | 51814 | `142060d5168fc523fd2ed96155e5988972f501ab6a3a102a33e1121d09b30028` | `0155437d5738980149145d3122c7bfdff159af51dce601244ada1f05a099678d` |
| 2 | `https://app.foodamigos.io/api/companies/threebuddies/data?hostname=www.threebuddies.de` | 9251 | `468482e7235c172f33829a1b272a69929a94abdd55cb5ab9e7dc73cd6cb927d0` | `21163d63a774d68346186382468cc0928a3e20661f8b80b7bcd589d5cf2d618a` |
| 3 | `https://app.foodamigos.io/api/companies/550/menus` | 209911 | `88d3e71db375553a4ad8bea5d6615abd0b471ac0ad471c6a4dc967c68f7c0b66` | `4cdcd60330f4fd3a253b8aa7c5ff42f852e091c5996eaa0a12434a468cac9141` |

All three returned **HTTP 200**. Verify the committed copies without re-fetching
anything:

```bash
cd venues/three-buddies-berlin
sha256sum -c <<'EOF'
0155437d5738980149145d3122c7bfdff159af51dce601244ada1f05a099678d  evidence/raw/store.json
21163d63a774d68346186382468cc0928a3e20661f8b80b7bcd589d5cf2d618a  evidence/raw/company.json
4cdcd60330f4fd3a253b8aa7c5ff42f852e091c5996eaa0a12434a468cac9141  evidence/raw/menus.json
EOF
```

## How the endpoints were found (and why the third one is the right one)

`evidence/capture-menu-requests.py` runs a headed browser (xvfb) on the venue's
own ordering route

```
https://www.threebuddies.de/speisekarte/threebuddies
```

and records every xhr/fetch it makes into `evidence/requests.json` (64 requests;
the venue-relevant ones are filtered to the top of the file by URL). The route
itself, its company id and its menu call are all visible there:

```
GET https://www.threebuddies.de/api/store                                            200
GET https://app.foodamigos.io/api/companies/threebuddies/data?hostname=www.threebuddies.de  200
GET https://app.foodamigos.io/api/companies/550/menus                                 200
```

**The company id it uses is 550, not the 509 the store payload advertises.**
Both `/companies/509/menus` and `/companies/550/menus` answer HTTP 200 with
different menus, so the browser's own choice — not a guess — is what this record
follows; the disagreement is published in `venue.company_binding`. Only the
`Abholung` (pickup) tab was captured successfully: clicking `Lieferung` opens a
delivery-address modal that intercepts the click, so the rendered-page anchor
covers the pickup column and delivery prices are JSON-only (see the README's
"Known gaps").

The capture script does not accept the cookie banner (which would store consent
state); it removes the overlay node so the page can be read. It never logs in and
never adds anything to a cart.

`https://threebuddies.de/api/store` answers **HTTP 308** (apex → `www`), which is
what the earlier single `curl` saw as "Redirecting…". The mirror
`https://storefront.foodamigos.io/api/stores/threebuddies.de` returns the same
payload and is recorded for reference only.

## Committed evidence files

```
evidence/raw/store.json              canonical copy of call 1   (redacted)
evidence/raw/company.json            canonical copy of call 2   (redacted)
evidence/raw/menus.json              canonical copy of call 3   (redacted: scrub pass only)
evidence/raw/_provenance.json        urls + sizes + sha256 of the responses as fetched
evidence/fragments/*.txt             verbatim byte-slices of the above (readable in the PR)
evidence/rendered-ordering-page.txt  text a real browser rendered on the ordering page
evidence/requests.json               every xhr/fetch the ordering route made
evidence/anchor/page-price-anchor.json  61 page-read prices (the expectation file)
evidence/capture-menu-requests.py    the recorder that produced requests.json
```

Evidence files are written with `json.dumps(..., indent=2, sort_keys=True)` plus a
trailing newline, so a re-fetch produces identical bytes when the venue's data has
not changed (`adapter.py --check` asserts this and prints the sha256).

## What the prices came from

`venue.json.menu.items[*].price` is `products[*].base_price` from call 3;
`prices_by_order_method` is that product's `order_method_prices` object. Both are
copied, never computed — `evidence/fragments/menus.product.fragment.txt` shows one
such object verbatim. The page anchor
(`evidence/anchor/page-price-anchor.json`) is read from
`evidence/rendered-ordering-page.txt`, i.e. from the venue's rendered page and NOT
from `venue.json`; `adapter.py --anchor` and `--verify-rendered` compare the two
(61/61 rows match), and `--negative-test` proves the comparison fails when a price
is perturbed.

## Redaction

The venue facts published here are the restaurant's own public data (name,
address, quarter, opening hours, service methods, menu, prices). Two mechanisms
keep everything else out of the committed files:

1. **A path list**, replaced with the string `[REDACTED]`:

   `evidence/raw/store.json`
   - `data.impressums[*].owner`, `.email`, `.phone_number`, `.tax_id`
   - `data.business_owners`
   - `data.google_cloud.api_key`
   - `data.service_provider.mixpanel_api_key`, `.notification_channels`
   - `data.companies[*].google_reviews` (third-party review authors)

   `evidence/raw/company.json`
   - `company.email`, `company.stripe_id`
   - `company.business_profile.owner_*`, `company.impressum.owner_*`
   - `company.service_provider.stripe_key`, `.adyen_key`, `.mixpanel_api_key`,
     `.amplitude_api_key`, `.platform_mixpanel_token`, `.google_analytics_id`,
     `.sender_email`, `.support_email`, `.otp_delivery_channels`

2. **A free-text scrub** applied to every committed copy *and* to `venue.json`
   (`scrub_free_text()`): every email becomes `[REDACTED-EMAIL]` and every
   phone-like run becomes `[REDACTED-PHONE]`. This exists because the platform
   embeds contact data **inside prose** too — the franchise pitch in
   `about_us_section` ends with a request to email an address at the venue's own
   domain (not reproduced here). A path list alone would have missed it; the
   adapter's leak guard caught exactly that on the first build and refused to
   write the file.

**Deliberately published** (the one exception, listed in `ALLOWED_PUBLISHED`): the
venue's own business phone number, which its storefront publishes and which
`venue.json` carries as `venue.phone` so a customer can call the order in. It is
the only phone-shaped value allowed to survive the scrub; every other one is
removed, and `--selftest` fails if `venue.phone` ever stops being that number.

The `sha256` values in the table above are of the **unredacted** responses, so
provenance stays checkable by anyone entitled to re-fetch them. The adapter
additionally fails the build (`PII_GUARD`, `assert_no_leak`, the `[REDACTED`
invariant) if a redacted value, an email, a key shape or a redaction placeholder
reaches a committed file — a redaction regression becomes a build failure rather
than a leak. Two such failures are recorded in the PR: the prose email above, and
the scrubber mangling the store UUID (`acc8c0b0-484b-…`), which the invariant
caught and the token-boundary fix resolved.

`evidence/rendered-ordering-page.txt` is written by the recorder through the same
scrub (`capture-menu-requests.py` imports `scrub_free_text` from the adapter, so
the policy cannot drift): the storefront's own contact block renders the
platform's masked company phone, which is therefore not reproduced in the committed
dump.

`evidence/raw/menus.json` contains no PII; it is committed with the scrub pass
only. `evidence/requests.json` records URLs, not bodies, and contains no keys or
tokens (checked: no `pk_live_`, `AIza`, `@` or `key=` in its 64 entries).
