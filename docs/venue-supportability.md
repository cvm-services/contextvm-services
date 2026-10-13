# Venue supportability: which venues can we actually settle in sats?

**Rule (operator, 2026-10-14):** we can only support venues that take payment
**online** for their orders. A venue whose only settlement is a physical terminal
needs the card (or cash) present at the counter, which our sats model cannot
serve — a facilitator standing at the till cannot complete the flow.

So "pay at the terminal" was the WRONG message. It is not an alternative payment
route we support; for our purposes it means **this venue is not supportable**.

## The three classes (measured, not guessed)

Classified by probing `app.foodamigos.io/api/store-config?hostname=<host>` — the
authoritative signal for "is this host a FoodAmigos storefront", i.e. does it
have the same online checkout API we mapped (`POST /order-drafts`,
`POST /stripe/payment-intents`, Stripe Elements).

| Venue | Online checkout | Platform | Supportable |
|---|---|---|---|
| three-buddies-berlin | yes | FoodAmigos (`threebuddies.online-karte.com`) | **yes** |
| doppelt-kaese-berlin | yes | FoodAmigos (`doppeltkase.online-karte.com`) | **yes** |
| ristorante-matera-berlin | yes | FoodAmigos (`ristorantematera.online-karte.com`) | **yes** |
| pizza-e-pasta-ruedesheimerplatz | **possibly** | AppSmart (`com.appsmart.pizzaepasta`, Android + iOS) | **unverified** |
| chandi-berlin | none declared | — (menu page only) | **no** |
| doreedos-steakhaus-berlin | none declared | — (contact page only) | **no** |
| la-mama-berlin | none declared | — (menu page only) | **no** |

## What each "no" actually means

- **chandi-berlin** — `ordering.urls` is null; the record points at
  `/menue/`, a menu page. No online ordering channel is declared.
- **doreedos-steakhaus-berlin** — the record's own "ordering" link is
  `/kontakt`, a contact page. The weakest case of the four.
- **la-mama-berlin** — `/menu/`, a menu page.
- **pizza-e-pasta-ruedesheimerplatz** — DIFFERENT: it declares an **AppSmart**
  ordering app (`com.appsmart.pizzaepasta`, iOS + Android) and a `/takeaway`
  page. Online ordering very likely exists, but on another platform, so our
  FoodAmigos API does not apply and it would need its own adapter. **Not
  verified** — do not claim it either way.

## Method note (why the first probe was discarded)

The first classifier scraped each venue's page for commerce keywords. It was
**unreliable and produced false negatives** — HTTP 429/403 rate-limiting made
three-buddies (a storefront whose checkout we have walked, and whose Stripe
bundle we have extracted) look like it had no online shop. Classification by
page-scraping is not evidence. The store-config probe is authoritative because
the platform either serves that host or does not.

## Consequence for the product

The console must not present a venue we cannot settle as orderable. The honest
states are:

1. **Orderable** — venue has a mapped online checkout (the 3 FoodAmigos ones).
2. **Not orderable** — no online checkout; the app should say so plainly rather
   than offering an order the facilitator then has to abandon.
3. **Needs an adapter** — an online checkout exists on an unmapped platform
   (pizza-e-pasta/AppSmart): a real feature to build, not something to fake.
