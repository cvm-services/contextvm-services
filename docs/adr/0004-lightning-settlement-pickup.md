# ADR-0004 — Pickup, prices and who settles: a Lightning-settled venue order

- **Status:** **Proposed** — awaiting operator sign-off. Nothing in here is built.
- **Date:** 2026-10-06
- **Tier:** docs/light
- **Depends on:** ADR-0001 (`D5` = the venue's own rail settles in v1; `D12` = the
  mandatory ring gate), `docs/spec/service-inputs.md` (the field register).

## Context

The two Berlin venue CVMs (`doppelt-kaese-berlin`,
`pizza-e-pasta-ruedesheimerplatz`) are **v1 deep-links**: the `order` tool is
zero-argument, `cap = 0 sats`, and the venue's own ordering page takes the order
and the money (ADR-0001 `D5`). Discovery works — the dashboard resolves both
venues — but three things are true at once and they are not the same problem:

1. **Fulfilment was declared wrongly (fixed 2026-10-06).** Both venues offer
   *pickup and* delivery, yet both announcements declared `cvm:req:ship.address`.
   That is a false claim about the appetite and it told every pickup customer to
   hand over an address they never need. Now: `order.fulfilment` is required,
   `ship.address` is optional and conditional on delivery.
2. **The headline price belonged to one method only.** 72 of 76 doppelt items are
   cheaper on pickup (Cheeseburger: **8.90 pickup** vs **9.50 delivery**). The
   announcement's single `min_price`/`max_price` came from the item's default
   column; it now carries `prices_by_method`.
3. **Nothing can be ordered by a machine, and nothing settles.** The tool takes no
   arguments, so it cannot select an item, cannot choose pickup, and cannot be
   paid. An agent can *find* a restaurant; it cannot *buy dinner*.

What the register already anticipates (it is not a new field discussion):

- `payment.method` — the rail: `bitcoin-lightning-bolt11`, `bitcoin-cashu`,
  `venue-card`, `cash-on-delivery`.
- `docs/spec/service-inputs.md`, on `payment.method`: *"In v1 the venue's own rail
  settles (D5); a CVM that accepts a payment method itself is v2 and **MUST say
  so**."* — this ADR is that decision point, for pickup only.

What we know about the venues' rails (no more than this):

- `doppelt`: `venue.settlement.rail` = *"venue's own rail (FoodAmigos storefront:
  Adyen/Stripe/PayPal/cash)"*, currency EUR, tax inclusive 19%, `cvm_cap: null`.
- `pizza`: `venue.settlement` is **null** — the adapter never recorded a rail.
- **Neither venue is recorded as accepting Lightning.** We therefore publish no
  Lightning claim today; claiming one would be an invented fact.

## Decision (proposed)

Split the ask in two and take the smaller one first, because the venues are
third parties whose rails we do not control:

- **v1.1 (in this card, no new settlement):** the announcements tell the truth
  about fulfilment, per-method prices and the recorded rail; the dashboard renders
  it. An agent can *plan* a pickup order and hand the human a deep link. No money
  moves through us.
- **v2 (needs sign-off before any code):** a **settlement CVM** for pickup orders —
  an `order` tool that takes real arguments (items, fulfilment) and returns a
  **bolt11 invoice**; on payment it places the order. This is the "MUST say so"
  case: the CVM itself accepts payment, so `payment.method:
  bitcoin-lightning-bolt11` becomes a legal and *required* declaration, and
  ADR-0001 `D5` no longer covers the flow.

The v2 build is gated on a commercial decision, not a technical one (below).

## Alternatives for v2, with a recommendation

| Option | Money flow | What has to be true | Verdict |
|---|---|---|---|
| **A. No-money agentic ordering** — the CVM places the order on the venue's own rail (their API or a headless flow) and the customer pays at pickup | none through us | venue terms permit automated ordering; a stable order API per platform | smallest honest step, but it is *automation of someone else's checkout*, so it needs the venue's written blessing first. **Recommended as a spike only** |
| **B. LN-settled reseller (recommended target)** — the CVM takes a Lightning payment and pays the venue by card/cash at pickup | customer → us (LN) → venue | venue agreement (we are not their merchant of record for free), a DE-legal invoicing story, refunds, and a reconciliation account | the only version that delivers "pay for my pickup order with Lightning" end to end. Needs a real agreement, not code alone |
| **C. Own-fulfilment counter** — we run the pickup point (a contextvm kitchen/counter) | customer → us (LN) → us | a kitchen, staff, hygiene/licensing | full control, zero third-party dependency, and it makes the CVM trivially honest — but it is a business, not a card |

**Recommendation: B, prototyped behind the ring gate on one venue, with A as a
throwaway spike to learn whether the venues' platforms can be driven at all.**
Cashu-first is worth considering before bolt11 (see Open questions) — it matches
the existing `pmi` posture on `nosms` and lets a mint do the reconciliation.

## Consequences if v2 is approved

- **Funds and failure:** we would hold customer money before the food exists.
  Refunds, no-shows, cancelled items and partial fulfilment all become our
  problem, and every one of them needs a written policy before the first order.
- **Declaration duties:** the announcement gains `payment.method:
  bitcoin-lightning-bolt11` (or `bitcoin-cashu`), a non-zero per-tool `cap`, and a
  `pmi` tag — today's 0-sat cap and `settlement: "venue-rail"` become false.
- **Ring gate (`D12`)** applies to the settlement step as it does to every paid
  tool; the invoice must not be issuable outside it.
- **Legal (DE):** who is the merchant of record, what the receipt says, and how the
  19% inclusive tax is passed through. This is the part that most often kills
  option B, so it is decided before the first line of code.
- **Pizza's missing rail** (`venue.settlement: null`) is a data gap the adapters
  must close regardless of which option wins — we cannot declare a rail we have
  not recorded.

## Open questions (operator)

1. **Which option**, and is a third-party venue's consent realistically available
   to us — or is C (our own counter) the honest target?
2. **Rail: bolt11 or Cashu first?** Cashu makes reconciliation and refunds easier
   and matches `nosms`; bolt11 is what a customer's LN wallet expects.
3. **Who is the merchant of record**, and does that need a German business entity
   before the first paid pickup order?
4. **Does a slot reservation without money (A) still need consent** if we drive the
   venue's own page on the customer's behalf? (My read: yes — and to say so in the
   tool description if we do it.)

## Not in scope

- Changing `D5` for v1 services, or adding any Lightning claim to the current
  announcements.
- Per-item machine ordering over the CVM without a settlement story (`payment`
  would be declared and never collected — the inflated-appetite failure again).

## References

- `venues/*/venue.json` — `order_methods`, `pickup`/`delivery`, `settlement.rail`,
  per-item `prices_by_order_method`.
- `docs/spec/service-inputs.md` — `order.fulfilment`, `payment.method`, tiers.
- ADR-0001 — `D2` (tags), `D5` (the venue's rail settles in v1), `D12` (ring gate),
  `D14`/`P15` (minimisation: declare no more than the flow collects).
- Fleet rules: `~/.hermes/AGENTS.md`; `urgency-aware-dispatch` (this ADR is SOON).
