# R2 — the `/order-drafts` contract, MEASURED (2026-10-19)

Captured from a live storefront session with a real cart (Capri Sun Kirsche, product
`1052466`, EUR 1.50). This closes R2: the payload is no longer inferred from error
messages, it is the actual wire body.

## The draft body

`POST https://app.foodamigos.io/api/order-drafts`

```json
{
  "method": "pickup",
  "customer_note": "",
  "delivery_street_name": "",
  "delivery_street_number": "",
  "delivery_city": "",
  "delivery_state": null,
  "delivery_country": null,
  "delivery_company_name": null,
  "delivery_doorbell_name": null,
  "delivery_zip_code": "",
  "delivery_dropoff_action": null,
  "order_instructions": "",
  "room_service_details": null,
  "coupon_details": null,
  "cashback_points": null,
  "tip": 0,
  "scheduled_for": "2026-10-20T10:45:00.000Z",
  "line_items": [{ "product_id": 1052466, "quantity": 1, "modifiers": [] }],
  "marketing_consent": false,
  "company_id": 550,
  "payment_method_id": null,
  "should_save_payment_info": false,
  "delivery_quote_id": null,
  "applied_offers": [],
  "utm": {},
  "tracking_consent": true
}
```

## The companion call — this is what was 500ing

The client sends the SAME object to a **second** endpoint, plus one extra field:

`POST https://app.foodamigos.io/api/order-validations`

```json
{ "...same as above...",
  "ignored_error_codes": [
    "pickup_closed",
    "delivery_closed",
    "order_time_not_available",
    "items_menu_time_unavailable"
  ] }
```

`pickup_closed` is the code our earlier probes tripped: the venue was shut (Monday
evening) and the cart was scheduled for the next opening. The storefront deliberately
tolerates that class of error so a customer can build a basket for a future slot.
A caller that omits `ignored_error_codes` gets a validation failure that reads like a
malformed payload — which is exactly how it was misdiagnosed as "a missing field".

## Resolved facts

- `company_id: 550` — confirmed on the live wire (the marketing payload's 509 is not
  the ordering company).
- `method: "pickup"` bypasses the delivery address block; every delivery field is still
  present but empty/null. A minimal payload is therefore NOT the contract — the client
  always sends the full shape.
- `line_items[].modifiers: []` is always present, even for a product with no options.
- `scheduled_for` is ISO-8601 UTC. For pickup the storefront converts local intent.
- `payment_method_id: null` at draft time — payment is attached later in the flow.
- `applied_offers: []`, `utm: {}`, `tracking_consent: true` are always sent.

## How the cart was reached (the path that works)

1. Venue radio: `get_by_role("radio").first.check()` — role-based, reliable.
2. If `Menü Anzeigen` is class-disabled, the venue is CLOSED — open the scheduler
   (`Ändern`), pick `Morgen` + the first `HH:MM` slot, `Weiter`.
3. Click `Menü Anzeigen`.
4. Search the product by name with the site's own search box (off-screen categories
   are not mounted; a search mounts them).
5. **Click the product ROW, not a `+` button.** Drinks have no `+` control at all;
   clicking the row opens the detail panel, whose `Hinzufügen` adds the item.
6. Cart icon (header) -> `Zur Kasse`.

Correction recorded: an earlier conclusion that "the cheapest addable item is EUR 4.50"
was wrong. It came from looking for a `+` on a searched result. The EUR 1.50 drink is
orderable via the row click.

## Payment surface at checkout (measured)

```
js.stripe.com     3 frames (incl. m-outer / payment-request)
pay.google.com    1 frame
m.stripe.network  1 frame
main frame        2 inputs
```

Card fields are inside Stripe's cross-origin iframes. Filling them requires
`frame_locator` on the Stripe frame; nothing about the main document exposes them.
