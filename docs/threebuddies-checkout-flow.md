# Three Buddies checkout — the real flow, measured (2026-10-14)

Source: the venue's own storefront bundle
(`www.foodamigos-storefront-online-shop.com/assets/index-DUDkLizQ.js`, 9.4 MB)
plus the operator walking the live checkout. The UI's own calls are the contract.

## Platform

FoodAmigos storefront. API base `https://app.foodamigos.io/api` (from the bundle's
own `VITE_API_BASE_URL`). Company id `550`.

## The checkout endpoints (extracted from the shipped bundle)

| Endpoint | Leg |
|---|---|
| `POST /order-drafts` | the basket draft — **before any payment** |
| `POST /order-validations` | validate the draft |
| `POST /orders` | place the order |
| `GET /orders/{uuid}` / `GET /orders/{uuid}/payment-status` | status |
| `POST /stripe/payment-intents`, `GET /stripe/payment-intents/{uuid}` | **card payment** |
| `POST /payment-setup-intents` | saved-card setup |
| `POST /paypal/orders` | PayPal |
| `/companies/{id}/gift-cards/checkout` | gift cards |

## Payment rails the venue actually wires

- **Stripe** — confirmed live: `merchant-ui-api.stripe.com/elements/wallet-config`,
  `js.stripe.com`, `POST /stripe/payment-intents`, `confirmCardPayment`,
  `stripePromise`. Stripe **Elements** = hosted card fields (cross-origin iframe).
- **Adyen** — also present (`.adyen-checkout__*` classes, `/checkoutshopper/`).
- **Cash** — in-store.

## What the checkout demands (operator-observed)

1. **Vorname, Nachname, Email Address** — free text.
2. **Phone number — mandatory**, with a country selector (`${phonePrefix}-${phoneNumber}`).
3. **Cash requires SMS phone verification** ("Wir müssen deine Telefonnummer
   verifizieren", "Code senden per"). Bundle strings confirm:
   "Es wurde eine Nachricht mit einem Verifizierungscode an dein Telefon gesendet".
4. **Card payment needs NO SMS verification** (operator-confirmed). It does sit
   behind **hCaptcha** (`VITE_HCAPTCHA_SITEKEY` is configured) and Stripe 3DS.
5. Totals observed: subtotal 1,50 EUR → Summe 1,50 EUR (cash), and with a card
   fee line 0,36 EUR → Summe 1,86 EUR.

## What the ContextVM CAN cover — and what it cannot

**Can cover (worth building):**
- **`order-drafts` + `order-validations`** — the basket leg. This upgrades the
  venue from `deep_link_human` to a genuinely pre-filled basket: the CVM prepares
  the customer's exact items at the venue's own API, then hands off. No payment
  authority changes (`submit: false` still holds).
- **Phone number**: `cvm-sms4sats` (cvm-service-kit) supplies a number + code —
  tools `list_services`, `catalog`, `create_sms_order`, `order_status`. This
  covers the *number*, and the code arrives as an SMS.

**Cannot cover, and must not pretend to:**
- **Card fields** — Stripe Elements are a cross-origin iframe owned by Stripe.
  Card data must be typed by the human on the human's device (ADR-0013). The CVM
  may open the checkout; it must never receive card material.
- **hCaptcha** — an explicit anti-automation gate on the checkout.
- **The venue's phone verification is account-bound** (country selection, code
  resent per attempt), not a plain "receive an SMS" flow. `cvm-sms4sats` gives a
  verifiable number; whether the venue accepts a non-carrier virtual number for
  *account* verification is UNPROVEN and must be tested before claiming it.

## Straight answer to "does the ContextVM cover this?"

**Partly, and the useful part is the basket.** The basket can be built against
the venue's own API (`order-drafts`), which is a real improvement over a bare
link. Payment cannot be automated: Stripe Elements owns the card fields, the
checkout is hCaptcha-gated, and 3DS is upstream. The honest end state stays the
hand-off in ADR-0013 — the console opens the venue's checkout, the human enters
the card on their device, and the console records only the result.
