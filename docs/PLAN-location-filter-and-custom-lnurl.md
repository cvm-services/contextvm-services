# PLAN — location filtering, custom LNURL, and Poznań manual test

Date: 2026-11-08. Owner: operator (cvm-registry customer PWA + cvm-orders).

See [`CHECKLIST-location-filter-and-custom-lnurl.md`](CHECKLIST-location-filter-and-custom-lnurl.md).

## 1. Goal

- Stop showing every venue to every customer.
- Let the customer use device location (explicit permission) or a manual city/coordinate
  fallback, then choose a radius.
- Keep location on the device; it is not sent to the venue or stored in OpenBao.
- Allow an operator to specify the LNURL-pay receiver used for the test order.
- Support a real Visa test at a Poznań restaurant through the existing
  `deep_link_human` adapter: the human places/pays at the venue, the CVM never
  receives card data.
- Never publish the trust root or its secrets.

## 2. Customer location UX

Controls above the venue list:

```text
[ Use my location ]   [ City: Poznań ▾ ]   Radius: [ 10 km ▾ ]   [ Show all ]
Using your location · 10 km straight-line radius
```

- `navigator.geolocation.getCurrentPosition()` only after the explicit button.
- HTTPS/PWA secure context required; permission may be denied or approximate.
- Denied/unsupported: show an error and offer city/coordinate fallback.
- City presets and manual `lat,lng` input are available without geolocation.
- Radius options: 5, 10, 25, 50, 100 km and all.
- Filter with haversine distance, sort nearest first.
- Exclude venues with missing coordinates while a location is active; show a
  separate count so an unknown location is never silently treated as nearby.
- Label distance as straight-line, not delivery eligibility.
- GPS coordinates live in page memory only; radius/last city choice may be kept
  locally only if no precise coordinates are persisted.
- No location values in order payloads, Nostr events, logs, or screenshots.

## 3. Venue data

- `site/menu.json` needs normalized `address` and `location` fields. They are
  currently present in `contextvm-services/venues/<slug>/venue.json` but are
  stripped by `capture_menu.py`.
- Add `tools/enrich_menu_locations.py` (or integrate into capture) to copy
  `venue.address` (`street`, `postal_code`, `city`, `country`, `lat`, `lon`) from
  the authoritative venue record into the served menu.
- Do not invent coordinates; missing means “location unknown”.
- The existing six venues are in Berlin. A Poznań venue is added only with its real address, coordinates, menu,
  direct order URL, and owner/operator confirmation. The current demo uses an
  explicitly labelled manual test item and requires the facilitator to confirm
  the restaurant's actual total; it is not presented as the restaurant's menu.

## 4. Poznań manual test

Recommended first candidate from the user's list: **Pizza Express i Burgery od
2001 r.** because it reportedly has its own online ordering. Before adding:

1. Obtain the restaurant's direct ordering URL (not Wolt/Uber/Pyszne).
2. Confirm it accepts Visa and supports pickup/delivery to the test address.
3. Capture its real menu/prices and add `venues/poznan-.../venue.json` with
   `adapter.class = deep_link_human`, public `ordering.primary_url`, address
   coordinates, and no card credentials.
4. Customer PWA filters to Poznań within the selected radius.
5. Customer pays the configured LNURL invoice.
6. Facilitator completes the venue's own checkout manually via its browser page
   or telephone/in-house flow. Card entry is manual in the VNC by default.
7. Facilitator records the venue's own confirmation/reference.
8. Never use a previously consumed test order for the live card demo.

If the restaurant only uses a delivery marketplace, treat it as a manual phone
order unless the marketplace permits direct checkout; do not automate its app.

## 5. Configurable receiving LNURL

Payment rail selection in `cvm-orders`:

- Existing Cashu mint rail remains the default.
- Operator-only configuration `LNURLP_PAY_URL` (https URL or `lnurl1...`) selects
  a generic LNURL-pay rail for the test.
- Only the operator sets it; it is never accepted from a customer request.
- Validate `payRequest` (`tag`, `callback`, min/max sendable), HTTPS, callback
  origin, and amount. Refuse redirects/private endpoints by default.
- Request `callback?amount=<msat>&comment=<order-id>`; require a BOLT11.
- Extract the payment hash from the invoice and verify settlement through a
  LUD-21 `verify` URL when advertised. Without a verifiable settlement source,
  remain `awaiting_payment`; never mark paid from the browser's claim.
- The LNURL receiver is separate from the venue card payment. Customer sats go to
  the configured receiver; the facilitator pays the venue with Visa.

## 6. Verification

- Unit tests: haversine/filter, missing coordinates, permission-denied path,
  manual city/coords, LNURL parsing/callback/verify, non-HTTPS refusal, no
  customer-supplied LNURL.
- PWA JS syntax and cvm-orders Deno tests.
- Live test in Poznań only after the real venue URL/menu is verified; stop before
  Continue for a no-charge UI rehearsal.
- Evidence must redact GPS, card number, CVV, phone, and customer address.


## 7. Current-host integration

- `/order-next/` is the current customer app and is backed by the LNURLP
  customer API; `/order/` is the older cvm-orders UI and keeps a separate
  location-filter implementation.
- The test host `testserver2` serves a combined menu (Berlin venues plus the
  manual Poznań test venue) to `/order-next-api/venues`.
- `CVM_MANUAL_VENUE_URL=https://www.pizza-express.pl/` opens the restaurant's
  own page in the VNC and leaves the whole order/payment to the facilitator.
- `/order-next-api` and `/venue/view` are temporarily routed to the isolated
  test services. Roll back both routes when x280 returns.
- The arbitrary-LNURL rail lives in `cvm-orders`; the current LNURLP customer
  app uses the T14 receiver. Both are operator configuration, never customer
  input.
