# Live PICKUP checkout check — doppelt Käse, Laubacher Str. 11, 14197 Berlin

**Card:** `t_52640123` (board `contextvm-services`) · **Run:** 243 · **Type:** read-only verification
**Checked:** 2026-10-10 02:06–02:20 UTC (= 04:06–04:20 Europe/Berlin) · **No order was placed.**

Run 1 is PICKUP (ADR-0010 amendment 2026-10-09). This file answers the five questions
from the venue's own rail text only. Where the venue publishes nothing the answer says
`UNKNOWN` — no inference is passed off as a fact.

## Sources fetched (all unauthenticated GETs, no browser needed for the data)

| # | URL | bytes | sha256 (as fetched 2026-10-10T02:06Z) |
|---|-----|-------|--------------------------------------|
| 1 | `https://www.doppelt-kaese-berlin.de/api/store` | 55124 | `e2daaa2b66224e4608b748141d73af0abd6de342fcabd6e9d383321846235e85` |
| 2 | `https://app.foodamigos.io/api/companies/doppeltkase/data?hostname=doppelt-kaese-berlin.de` | 10519 | `b841e2c8e40e37060b46c83741cde35948a1b2c0fc865d1b424e3a6db5e919a5` |
| 3 | `https://app.foodamigos.io/api/companies/1387/menus` | 123592 | `be94ef8742f14d8705235135192ee2fe8418c63a0bc20369893d396f6bb24c34` |
| 4 | `https://www.doppelt-kaese-berlin.de/` and `/speisekarte/doppeltkase` (served HTML shell) | 160681 / 2138 | (shell; carries no prices) |
| 5 | `https://www.foodamigos-storefront-online-shop.com/assets/index-DMm5n3TU.js` (the ordering app the venue's `/speisekarte/…` page loads) | 9288720 | `a42e9d46bd532933c97a3cf7d766ca941f8f2147d84abc212265f7e6a2ddb196` |

Response 2 and 3 carry live credentials/PII in other fields; **they are deliberately not
committed**. The sha256 above is of the response as fetched, so anyone entitled to re-fetch
can still check provenance. The extracted, secret-free facts are in `check-facts.json`.

Caveat on the window: at 02:06 UTC the venue was **closed** (`open_now: false`), so every
answer below is the rail's *published configuration*, not a live open-for-orders
observation. Order-method availability while open was not observed.

## 1. Does the rail accept a PICKUP order; account/login or guest checkout?

**PICKUP: YES, offered as a first-class method.**

- The venue's own published text (its home page, response 4):
  > “…Cheeseburger, BBQ Burger und Chicken Burger bieten wir sowohl **Abholung als auch Lieferung** an, um unseren Gästen den besten Service zu bieten.”
  > “Wir bieten sowohl Abholung als auch Lieferung an!”
- Rail payload: `has_pickup: true`; `hidden_order_methods: ["room_service"]` (so the offered
  methods are **pickup** and delivery); every product carries an explicit pickup price in
  `order_method_prices.pickup` (e.g. Cheeseburger 9.50 dine-in → **8.90** pickup).

**Guest checkout: YES — no account/login required. Login is offered, never demanded.**

- The rail's own auth context exposes `{isLoggedIn, isGuest: !isLoggedIn, login, logout}`.
- At checkout the login banner is rendered **only for guests** and is promotional, not a gate
  (`OrderInfoSection`: `isGuest && <LoginBanner/>`). Its own German copy:
  > “Hast du schon ein Konto? **Anmelden** um deine Punkte & gespeicherten Infos zu nutzen”
  > “**Kostenlos registrieren** — sammle Prämien bei jeder Bestellung”
- The only fields a guest must supply are the customer-info fields
  (`customer_first_name`, `customer_last_name`, `customer_email`, `customer_phone_number`) —
  no account, no password. The rail labels the resulting order `guest_or_account: "guest"`
  in its own order analytics, i.e. guest orders are a supported first-class case.
- No field in the venue's own payload gates guest checkout (`grep -ci guest` over responses
  1 and 2 = 0), so nothing the venue declares turns a login into a requirement.

Residual `UNKNOWN`: end-to-end guest checkout is read from the rail's own logic and payload,
not from a placed order (placing one is out of scope for this card). Nothing published
suggests a staff-side rule refusing guest orders.

## 2. Pickup lead time and minimum order

From the venue's own payload (response 2), all live:

| field | value | what the rail does with it |
|-------|-------|----------------------------|
| `average_order_preparation_time` | `{"min": 10, "max": null}` | the ASAP **pickup** ETA; rendered as “Standard 10 min, Heute” (same field the delivery path replaces with `average_order_delivery_time`) |
| `min_schedule_ahead_time_pickup` | `45` | passed to the rail as `scheduleAheadTime` — minimum lead for a *scheduled* pickup slot |
| `last_order_gap_pickup` | `30` | `lastOrderGap` — last pickup order 30 min before closing |
| `has_asap_orders` / `has_scheduled_orders` / `has_pre_order` | `true` / `true` / `true` | ASAP and scheduled pickup both available |
| `max_pre_order_days` | `7` | booking horizon |
| `scheduled_orders_time_slot_interval` | `10` (min) | slot granularity |

**Published pickup lead time: 10 minutes** (ASAP), plus 45 min minimum for a *scheduled*
pickup and a 30-minute last-order cut-off before closing.

**Minimum order for pickup: NONE PUBLISHED.**

- The venue's only thresholds are the delivery zone's
  `min_threshold: 20.00` / `max_threshold: 750.00` (`delivery_zones[0]`, circle r=5000 m,
  fee 5.00), and the rail applies thresholds **only for delivery**: `useDeliveryThreshold`
  reads `method === delivery ? delivery_zone.min_threshold : null`.
- Independently of the venue, the storefront refuses a payment total between 0 and 1
  currency unit: `hasReachedCheckoutThreshold = total === 0 || total >= 1`, surfaced in the
  rail's own words as “**Mindestzahlungsbetrag**: Wir sind nicht in der Lage, Zahlungen
  zwischen … anzunehmen”. That is a payment-gateway floor applying to every order method,
  **not** a venue minimum order.

`UNKNOWN`: no pickup minimum is published anywhere we can read. Treat the practical floor as
€1.00 (payment floor) unless the operator wants to verify with the venue by phone.

## 3. CRITICAL — online card payment for pickup, or payment at collection?

**ONLINE CARD IS OFFERED. Payment at collection is NOT offered.**

Venue payload (response 2), live:

- `payment_gateway: "adyen"`, `payment_gateways: ["adyen", "stripe"]`
- `supported_payment_methods: ["apple_pay", "google_pay", "card", "pay_by_bank", "paypal"]`
- `hidden_payment_methods: []` (nothing hidden per order method — the same set applies to pickup)
- `has_in_store_card_payments: false`
- `overwrite_cash_payments_to_invoice: false`
- `saved_cards_enabled: true`
- `stripe_platform_payment_methods: ["paypal"]`

Why that means "online only, no pay-at-counter": the rail builds its payment list from that
array and only offers a method whose id is present —
`return q.supported_payment_methods?.includes(O.payment_method_id) && …`. `cash` (the method
the rail renders as “**Vor Ort zahlen (Bar/Karte)**”, shown when `has_in_store_card_payments`
is true) is **not** in the array and `has_in_store_card_payments` is **false**, so no
on-site/collection payment option exists. `hidden_payment_methods` is empty, so nothing is
additionally hidden *for pickup*.

**Named flow (run 1 would exercise it):** prepaid online at checkout —
- **Card / Apple Pay / Google Pay / Pay by Bank → Adyen** (`payment_gateway: adyen`; the
  bundle maps `scheme→card`, `applepay→apple_pay`, `googlepay→google_pay`,
  `paybybank→pay_by_bank`).
- **PayPal → the platform's Stripe leg** (`stripe_platform_payment_methods: ["paypal"]`).

**Consequence for the run-1 gate (state it plainly):** there is *no* collect-at-counter
fallback, so the fiat rail **is** exercised on run 1. If the sats→fiat leg cannot complete an
Adyen checkout, run 1 cannot be paid for on the venue's own rail at all.

## 4. Price reconciliation against our stored 2026-10-05/06 capture

**NO DIFF OBSERVED.** Live menus re-fetched 2026-10-10T02:06Z vs
`venues/doppelt-kaese-berlin/evidence/raw/menus.json`:

- 87 products on both sides; **0 SKUs added, 0 removed**; 9 categories, 5 modifier groups both sides.
- **0 price differences.** Every product's `base_price` **and** its whole
  `order_method_prices` object (pickup / delivery / dine_in / room_service) are equal.
- Concrete small basket, pickup, both sides identical:
  | item | SKU | capture | live |
  |------|-----|---------|------|
  | Cheeseburger | 331227 | base 9.50 / **pickup 8.90** | base 9.50 / **pickup 8.90** |
  | Curly Fries | 331233 | base 4.90 / **pickup 4.50** | base 4.90 / **pickup 4.50** |
  | **basket total (pickup)** | | **13.40** | **13.40** |
  | Der Doppelt Käse-Burger | 331230 | base 11.50 / pickup 10.90 | base 11.50 / pickup 10.90 |

- **What did move (not prices)** — reported so the drift is not hidden:
  - `menus[0].is_active` `false → true` (a venue-side menu toggle);
  - `is_available` `false → true` on 5 SKUs — `331239` (Chicken Fingers 9 Stück),
    `331262` (Pilz-Burger), `331266` (Beyond Pilz-Burger), `334624` (Chicken Fingers
    6 Stück — our `venue.json` still marks it unavailable), `334625`
    (Chicken Fingers 12 Stück);
  - `likes_count` bumped on `331230` (Der Doppelt Käse-Burger), `331243`
    (Beyond Meat-Burger), `334626` (Onion Rings 12 Stück).
  - Outside the price scope but relevant to ordering windows: in both `work_schedule` and
    `delivery_schedule` the entries whose `open.day` is **4, 5 and 6** moved their opening
    hour **13:00 → 12:00** (the payload does not name the weekday, and every other day is
    unchanged). `current_work_schedule` also differs between the two fetches, but only
    because it means "today" and the two fetches are on different days — not a schedule
    change.

## 5. Delivery-area eligibility

Not in scope for run 1 (owned by `t_7d410f66`). For the record only, the venue still declares
one external delivery zone (circle, r = 5000 m, centre 52.4707069 / 13.3202819,
min 20.00, max 750.00, fee 5.00) — **not** used or relied on here.

## Verdict

Every question the card asks is answerable from the venue's own text, and none of them is a
"no":

1. Pickup: **yes**; **guest checkout allowed**, login optional.
2. Pickup lead time **10 min** (ASAP; 45 min minimum for a scheduled slot, 30 min last-order
   cut-off before closing); **no pickup minimum published**.
3. **Online card is offered (Adyen card/wallets, PayPal via Stripe) and payment at collection
   is not** — so run 1 *does* exercise the fiat rail.
4. Prices: **NO DIFF OBSERVED** (0/87 price changes; identical €13.40 pickup basket).

Nothing here blocks run 1 as a pickup order. The one fact that changes the plan is Q3: the
"no card needed, pay at the counter" path does not exist.
