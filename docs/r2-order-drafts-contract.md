# R2 — `POST /order-drafts`: the measured contract and its ceiling (2026-10-16)

**Status:** MEASURED (partially). R2 is **partially blocked** on a real product id.
**Method:** live requests against the venue's own API, iterating on the API's own
validation errors. No guessing: every field below came from the server telling us.

## Correction to our own notes

Our prior note said the FoodAmigos company id was **550**. It is **509**.

- `companyId: 550` → `404 No query results for model [App\Models\Company]`
- `company_id: 509` → validation proceeds

550 came from a config value read out of the shipped bundle; 509 is what the
storefront's own payloads actually carry. **The bundle's config was not the truth —
the running app's request was.** Recorded because a wrong constant here silently
produces "no such company" forever.

Also note the field is **snake_case `company_id`**, not camelCase `companyId`.

## The measured contract

`POST https://app.foodamigos.io/api/order-drafts` with
`content-type: application/json` and a browser-ish UA.

```jsonc
{
  "company_id": 509,          // REQUIRED. integer. 509 = three-buddies.
  "method": "pickup",         // REQUIRED. "pickup" avoids the delivery address block.
  "line_items": [             // REQUIRED (must be PRESENT, even if empty)
    { "product_id": "<id>", "quantity": 1 }   // product_id REQUIRED per line
  ]
}
```

### How the shape was established (server-driven, in order)

1. `{}` → `422` `method` required + `line_items` must be present.
2. `method: "delivery"` → `422` additionally requires `delivery_quote_id`,
   `delivery_street_name`, `delivery_street_number`, `delivery_city`,
   `delivery_zip_code` (+1 more). **This is why `pickup` is the right choice** — it
   bypasses the whole address/quote block.
3. `method: "pickup"` → `422` `line_items.0.product_id` required. (Not `article_id`,
   not `id` — `product_id`.)
4. `product_id` supplied → **`500 Server Error`**.

## THE CEILING (the honest finding)

The request passes **every validation rule** and then fails server-side with a
`500`. That means:

- **The request SHAPE is correct and fully known** — we got past 422s entirely.
- The 500 is not a shape problem, so the remaining unknown is the **value** of
  `product_id`. Our venue records carry `sku` (e.g. `1052491` = Curly Fries) but the
  API rejected it as a lookup and errored rather than 404-ing.
- **We have no menu/products endpoint.** Probed and 404: `/companies/509/products`,
  `/companies/509/articles`, `/companies/509/menu`, `/companies/509?include=...`,
  `/store/509/products`.

**Therefore a basket CANNOT be constructed from the data we currently hold.** The
missing piece is the mapping from our menu `sku` → FoodAmigos `product_id`.

## What unblocks it (in preference order)

1. **Read the real `product_id` from the storefront's own request.** The storefront
   builds the draft client-side; a Playwright walk of
   `threebuddies.foodamigos-storefront.com` adding an item to the cart records the
   exact `order-drafts` body — ids included. This is the same "the UI's calls ARE
   the contract" method that mapped the rest of this API.
2. Ask the operator for one captured draft payload.
3. Find an unauthenticated catalog/network endpoint we have not guessed.

### Progress on (1) and (3) — measured 2026-10-16

**A SECOND API HOST exists that we had not found: `storefront.foodamigos.io`.**
The storefront does not read its menu from `app.foodamigos.io`; it calls
`GET https://storefront.foodamigos.io/api/templates/481` and
`GET https://threebuddies.foodamigos-storefront.com/api/store`, and it resolves the
company by **hostname**, not by numeric id:
`GET https://app.foodamigos.io/api/companies/threebuddies/data?hostname=...`.

That call independently confirms **`company.id = 509`** — the same value established
from the validation errors, now corroborated by the platform's own data.

`GET /api/store` (51 KB) yields a `products` array with real ids, e.g.
`2685` = "01. Hamburger" (8.90), `2694` = "10. Burger Manhattan" (11.90). These are
**storefront product ids and they are NOT the ids `order-drafts` wants**: submitting
`product_id: 2685` with `company_id: 509` still returns **`500 Server Error`**.

So the mapping is still missing, and the failure has narrowed usefully:

- our menu `sku` (`1052491`) → 500
- the storefront's own `products[].id` (`2685`) → 500

Both wrong, both 500. The remaining likely sources for the right value are the
**app-side** article ids (the `1052xxx` family our venue records already carry may
be POS ids needing a different field), or a field the draft requires that we are
still not sending alongside `product_id`. Distinguishing them needs the storefront's
actual draft body — option (1) — because further blind probing against a
rate-limit-shared host is guesswork, not measurement.

**An attempted walk (`tools/threebuddies_draft_recon.py`) found no add-to-cart
controls** on the initial DOM (the menu renders client-side after hydration), so
option (1) needs a selector-aware walk rather than a keyword sweep. The tool is
committed as-is with that finding, as the starting point for whoever does it.

## What R2 must NOT do

- Must not invent a `product_id`, and must not treat the 500 as success.
- Must not remove `submit: false`. The human holds payment authority.
- Card fields live in Stripe **cross-origin iframes**; hCaptcha gates checkout.
  The CVM prepares a basket; it never receives card material (ADR-0013).

## Consequence

R2 is **blocked-with-a-measured-reason**, not unstarted: the contract is known, the
only missing input is the `sku → product_id` mapping. The floor is unchanged — the
venue already works via `deep_link_human`; `order-drafts` would upgrade it to a
genuinely pre-filled basket.
