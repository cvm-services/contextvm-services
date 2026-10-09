# ADR-0007 — One venue adapter interface, three classes; do not wrap an aggregator

- **Status:** **Accepted 2026-10-09** — operator decision ("instead of wrapping an aggregator I recommend
  a `venue adapter` interface inside the CVM"), recorded here.
- **Date:** 2026-10-09
- **Decided:** the venue CVM grows a single `venue adapter` interface with three classes; wrapping a
  consumer food-delivery aggregator is **rejected** as an architecture.
- **Tier:** docs/light
- **Depends on:** ADR-0001 (`D5` — the venue's own rail settles in v1), ADR-0004 (who settles).

## Context

The goal is *facilitated orders at any venue*. Two ways to widen venue coverage were on the table:

1. **Wrap an aggregator** (Lieferando / Wolt / Uber Eats) to inherit their venue list.
2. **Talk to venues directly** through a per-venue adapter.

Claim 1 was checked rather than assumed. A consultant review
(`~/reports/cvm-aggregator-claims-vetted-2026-10-09.md`, dated URLs) found the checked official
developer surfaces are **merchant/POS integration surfaces only**: Wolt exposes Marketplace/POS
integrations and Wolt Drive for *sellers'* own web stores; Uber Eats and Lieferando expose nothing
for a consumer to place a third-party order, and **no anonymous consumer order API was verified**.
Wolt Drive and Uber Direct are *courier* APIs — they move goods, they do not take an order.

A live survey of Steglitz (87 named venues, postcode 12163/65/67/69, 2026-10-09) put numbers on the
alternative: 54 venues have a phone, 59 a website, 47 both; only **7** sit on a platform rail
(Lieferando x4, pizza.de x2, wolt x1) and the rest take an order from a human today.

## Decision

1. The venue CVM exposes **one `venue adapter` interface**. A venue is onboarded by choosing a class
   and supplying config; it is not a new code path.
   - **Class 1 — deep link + human.** The CVM returns the basket, the venue's own rail and the
     deep link; a human (today: the operator/facilitator) places the order. This is v1 and it works
     for every venue that accepts an order from a person, which is nearly all of them.
   - **Class 2 — browser automation of a venue-owned rail** where the venue has no API. Explicit
     **per-venue opt-in**, because it carries consumer-account ToS/ban risk, credential custody and
     payment liability.
   - **Class 3 — direct API**, where a venue actually has one.
2. **Wrapping a consumer aggregator is rejected.** It is not an adapter class, and the account
   automation that would make it work is the Class 2 risk concentrated in a third party whose terms
   we do not control.
3. Platform-hosted venues stay **possible but opt-in**: they are a configuration choice with a
   written risk note, never the default path.

## Consequences

- "More restaurants" becomes a data/config problem with a measurable proof: onboarding a venue
  should touch **zero code files** (card `t_a640b7ca` measures exactly that on three Steglitz venues).
- The CVM is not the settlement rail and does not need aggregator integration to grow.
- A Class 2 venue must record, per venue, who holds the credential and what happens on a ban; that is
  a reviewable artifact, not an implementation detail.
