# ADR-0010 — The first real facilitated order: Doppelt Kaese, delivery preferred

- **Status:** **Accepted 2026-10-09** — operator decision, five answers recorded verbatim below.
- **Date:** 2026-10-09
- **Decided:** venue, fulfilment, contact identity, food payment and money type for the first real
  Tier-B order.
- **Tier:** docs/light
- **Depends on:** ADR-0004, ADR-0007, ADR-0008, ADR-0009, gap analysis G7.

## Context

The operator asked what a real order needs and whether Steglitz venues exist. Answer: both current
venues are real (`doppelt-kaese-berlin`, Laubacher Str. 11, 14197 Berlin, OSM node 6684579291,
76-item menu with real SKUs; `pizza-e-pasta-ruedesheimerplatz`, Ruedesheimer Str. 9, 14197 Berlin),
and Steglitz adds 87 more venues, 47 with both a site and a phone.

## Decision (operator, 2026-10-09)

1. **Venue:** start with **Doppelt Kaese** ("lets start with doppelt kaese").
2. **Fulfilment:** **delivery if possible**, pickup acceptable ("Delivery if possible, otherwise I'm
   willing to pickup as well").
3. **Contact:** use **the phone number the CVMs manage** ("Use the phone number that you manage with
   your contextvms").
4. **Food payment:** **card on the venue's own rail**, via the 2fiat card CVM; schedule the card path
   if it does not work yet ("card on the venue's rail. Use your contextvm for managing 2fiat.com
   cards. Please schedule this if it doesn't work yet").
5. **Money:** **real sats** (see ADR-0008), with the fiat leg gated on settlement.

## Consequences and known gaps (recorded honestly)

- **The card path does not work yet.** Per ADR-0008, `cvm-2fiat` has no payment tool by design and the
  private local adapter that could drive a checkout is SCOPED, not built. This is scheduled, not
  assumed.
- **Voice reachability of the contact number is unresolved.** The number our CVMs manage is an SMS
  identity (nosms-pooled, routed to an npub), not a voice line. A delivery driver who *calls* it will
  not reach a human. Delivery needs a number a human answers; that must be settled before a delivery
  order, or the order is placed as pickup.
- **Menu freshness gates the basket.** G7 (card `t_0eccac0c`) still applies: the served menu is a
  2026-10-06 capture, and a basket built from stale data must not reach the pay step.
- **Declared fulfilment facts are suspect.** The venue announcement declares delivery areas
  (Mitte/Kreuzberg/Friedrichshain) that are not where the venue is; card `t_7d410f66` re-derives them.

## Amendment 2026-10-09 (contact identity resolved)

The operator decided the delivery contact leg: **the operator's own mobile number**, supplied as an
input to the venue CVM for that order. The CVMs stay **out of the contact path** entirely - they do
not own, rent or relay the number a delivery driver calls. The SMS-only identity the CVMs manage
(nosms pooled, routed to an npub) is therefore **not** the contact and must not be offered as one: a
driver cannot call an npub.

Consequence: a contact phone is a **per-order input**, required when the venue's rail needs one, and
never a property of the venue announcement. The venue's CVM must reject an order that needs a contact
number and was given none, rather than substituting anything.

## Amendment 2026-10-09 (fulfilment: pickup for run 1)

The operator asked whether he can collect at the restaurant. Yes - and both venues already
publish a pickup price for every item (`prices_by_order_method` carries `pickup` next to
`delivery`; Doppelt Kase quotes pickup at 10 minutes), so pickup is not a workaround, it is an
offered method.

Run 1 is therefore **pickup**, and delivery becomes a separately-verified capability rather than a
default. This is not a downgrade, it removes three of the top failure risks at once:

- **no delivery-area question.** The templated delivery-area facts (card `t_7d410f66`) stop gating
  the first order: we are not claiming a delivery the venue may refuse.
- **no driver call.** The SMS-only contact problem disappears for run 1 - nobody needs to phone a
  human at the door. (The contact-phone input stays for delivery and for a venue that rings when an
  order is ready.)
- **no delivery-fee surprise.** The stale-menu risk that matters most (a basket priced from a
  2026-10-06 capture) is smaller when the number of priced inputs is small.

Honest consequence to keep visible: **the card-on-the-venue-rail leg is only exercised if the order
is paid online at checkout.** If the venue offers collection payment (cash/own card at the counter),
run 1 can complete without the fiat rail at all - which would leave the sats-to-fiat gate unproven.
The verification card must therefore report whether online card payment is offered *for pickup*, so
this is a fact, not an assumption. Run-1 cap and refund policy, if the operator does not restate
them, default to EUR 30 including fees and 'the operator bears a first-run settled-sats/failed-fiat
loss'.
