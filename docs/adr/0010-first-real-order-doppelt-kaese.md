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
