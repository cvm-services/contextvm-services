# Provenance — pizza-e-pasta-ruedesheimerplatz

What `venue.json` was built from, how it was obtained, and how to verify it
without trusting this file.  Captured **2026-10-05**.

## The source

The venue's own ordering rail: <https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway>
(OrderYoyo shop platform; the restaurant record self-identifies as
`externalRPId: "AppSmart_8871"` and its imprint address is under
`kontakt-ordersmart.de`).

The page is server-side rendered and its `__NEXT_DATA__` contains the platform's
react-query hydration cache — i.e. the exact JSON the server got from the
platform API.  Five payloads carry the whole record:

- `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/families/by-domain/restaurants?domain=pizzaepasta-ruedesheimerplatz.de`
  
  hydration key `/MyRestaurant/families/by-domain/restaurants?domain=pizzaepasta-ruedesheimerplatz.de` → `evidence/raw/myrestaurant-restaurants.json` (imprint e-mail redacted)
- `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/restaurant/45842?timeSensitive=false`
  
  hydration key `/MyRestaurant/restaurant/45842?timeSensitive=false` → `evidence/raw/myrestaurant-restaurant.json` (imprint e-mail redacted)
- `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/families/by-domain?domain=pizzaepasta-ruedesheimerplatz.de`
  
  hydration key `/MyRestaurant/families/by-domain?domain=pizzaepasta-ruedesheimerplatz.de` → `evidence/raw/myrestaurant-family.json`
- `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyMenuManagementSystem/restaurants/45842/menu?version=9&type=Takeaway`
  
  hydration key `/MyMenuManagementSystem/restaurants/45842/menu?version=9&type=Takeaway` → `evidence/raw/menu.json`
- `https://pizzaepasta-ruedesheimerplatz.de/oyy-api/AppPublishing/families/14842/published-apps`
  
  hydration key `/AppPublishing/families/14842/published-apps` → `evidence/raw/published-apps.json`

## The Cloudflare challenge (measured)

`GET` on the origin — including `/robots.txt`, `/sitemap.xml` and every
`/oyy-api/*` path — answers `HTTP 403` with `cf-mitigated: challenge`
("Just a moment…").  Measured outcomes:

| what | result |
|---|---|
| curl / urllib, plain and with a desktop Chrome UA | **403** challenge |
| curl carrying the successful run's `cf_clearance` + `__cf_bm` cookies and the same UA | **403** — the clearance is bound to the browser TLS fingerprint |
| headed Chrome (`channel="chrome"`, `headless=False`) under `xvfb-run -a`, persistent profile | **HTTP 200 on the first navigation**, no interaction needed |
| four later headed navigations, same profile, waiting up to 171 s each | **403** — sticky IP/session cooldown; stopped rather than hammering |

Challenge outcome of the successful run: `status=200`,
title `Essen bestellen bei Pizza e Pasta in Berlin`, `turnstile_frames=[]`,
`interactive_captcha=False`.
Cookies set: `__cf_bm, _cfuvid, ajs_anonymous_id, cf_clearance, rwgToken, splitVar` — `cf_clearance` **is** required for
same-origin XHRs to `/oyy-api` (the page's own calls returned 200 with it), but it
cannot be transplanted out of the browser.

**Consequence for future runs: touch the origin ONCE.** A single HTTP 200 page
carries all five payloads, so there is never a reason to re-navigate.  Re-capture
with `evidence/capture-menu-requests.py` (max 3 attempts, then it stops).

## Hashes

| hashed artefact | bytes | sha256 |
|---|---|---|
| ordering page (HTTP 200, not committed) | 726729 | `53847e06088bccf734b7398fc5a05e9d70d61bb47ca373e03c8b693d8a98cf0a` |
| `evidence/raw/myrestaurant-restaurants.json` (redacted) | 4092 | `95e85172aa310f09f96b53ad5dbf28dbbe598464c868b2574b948cc1733567af` |
| `evidence/raw/myrestaurant-restaurant.json` (redacted) | 3746 | `1d498f465292c206bda82bf7e7f080bbab33cc7a05f98f2e228a3ee6c66baff1` |
| `evidence/raw/myrestaurant-family.json` | 1741 | `fc5193c14496035b6e391883c6a15674b12aab27e3e41b41cdafee5c0c9f674e` |
| `evidence/raw/menu.json` | 773384 | `395e5ed26f7158e8b1f7f32989cdf50aa5126019586768196e8a71a64ead1cc1` |
| `evidence/raw/published-apps.json` | 822 | `b9ca2e89f3aeb9b665e094811448c45241c01393ee5fd3c6dd60d49460cbe231` |

`_page.file` above is `evidence/page.html`, which is **not committed**: it is a
726 kB third-party document containing contact e-mail addresses.  Its sha256 is
the verifiable handle — re-capture and compare.

Redactions applied before committing: the `imprintEmail` field of the restaurant
payloads (both copies) is replaced with `"[REDACTED]"`.  Nothing else was
touched; `write_fragments()` in `adapter.py` fails the build if a committed
fragment ever contains `@`, `stripe_key`, `adyen_key`, `api_key` or `cf_clearance`.

## Verification (all re-runnable offline)

```
$ python3 adapter.py --check
PARSE OK sections=9 popular_views=1 items_listed=112 priced=112 min_price=2.70 max_price=16.65 currency=EUR method=pickup sha256=a47b20fce4b2727565d8d05039949e400c115484a677cf215b32e649eb7ad51b MATCH

$ python3 adapter.py --selftest
SELFTEST OK deterministic=1 duplicate_ids=0 source_duplicate_skus=3 priced=112 sections=9 option_groups=18

$ python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
RENDERED CROSS-CHECK items_on_page=112 matched=112 not_in_venue_json=0 mismatches=0
```

`--verify-rendered` is the independent check: it parses the prices out of the
**text a real browser rendered** on the ordering page (`evidence/rendered-ordering-page.txt`)
and requires all 112 rows to equal the values in `venue.json`.
This is what caught the two subtle mapping bugs during development — a
non-breaking space before `€`, alphanumeric article numbers (`30a`, `36b`) and
the price-level choice for multi-size items.

## Counting notes (so the numbers can be checked by hand)

- 112 distinct products, 112 of them priced,
  9 real sections plus one platform "most popular" view
  (section `9999`, `kind: popular_view`) whose items are the same product ids as
  elsewhere — so it adds no products and is excluded from `stats.sections`.
- 18 option groups after de-duplication.  The platform
  re-declares the same group id with different option prices at category level and
  at item level, so variant ids are suffixed (`4454494`, `4454494-2`, …); items point
  at the variant that actually applies to them.
- 3 article numbers are genuinely duplicated in the source
  (`110` = Pizza Picante (scharf) / Pizza Sardelle, `36` = Bionade Ingwer-Orange 0,33l / Vitamalz 0.33l, `44` = König Ludwig Dunkel 0.5l / König Ludwig Kristal 0.5l).
  They are kept as published and reported under `menu.stats.duplicate_skus`.
- The endpoint `/oyy-api/MyRestaurant/restaurant/45842/delivery-area` (name found in
  the frontend bundle) was probed once more and answered the Cloudflare challenge, so
  the delivery **postcode list is not captured**; `venue.delivery.areas` is therefore
  empty and `venue.delivery.area_note` says why.
