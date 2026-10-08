# PLAN-0006 — Options, and the road from a basket to a settled order

> **UPDATE 2026-10-08 — partly superseded by [PLAN-0007](PLAN-0007-facilitated-orders.md).**
> The operator approved the facilitated two-persona model (customer pays sats,
> facilitator pays fiat at the venue). Consequences for this plan:
> - **Track E (settlement)** is now **facilitator-mediated** (PLAN-0007 T2): the paid
>   leg takes the money and the *facilitator* places the order — the "honest stop"
>   below (G-e) is answered by a human, not by venue APIs.
> - **Track C (own counter)** is **deferred** (PLAN-0007 D10) — no longer required
>   for the v2 demo; kept as a later venue.
> - **Track D (options)** is unchanged and absorbed as **PLAN-0007 T5**.
> - Open questions 1–3 at the end of this document are **answered** (PLAN-0007 D9,
>   D10, and Q3 confirmed: `settlement: null` stays).

- **Status:** **Draft — awaits operator sign-off.** No code until approved (the
  standing plan gate).
- **Date:** 2026-10-07
- **Urgency:** SOON. No money is lost while it waits; Track E is blocked on
  commercial answers, not on engineering.
- **Depends on:** ADR-0004 (`option B` accepted, **Cashu before bolt11**,
  merchant-of-record OPEN), ADR-0005 (presentation is client-side),
  PLAN-0005 (orderable venues — Stage 1 shipped), `docs/spec/service-inputs.md`.
- **Supersedes nothing.**

## Where we actually are (verified live, 2026-10-07)

A real CVM client was driven against both venue servers over
`wss://relay.primal.net` and got a real answer:

```
order -> status: basket
         2 x Cheeseburger 8.90 + 1 x Curly Fries 4.50 = 22.30 EUR
         "This is a prepared basket, not a placed order.
          Checkout and payment happen on the venue's own page."
```

So Stage 1 works end to end: `menu` returns 188 real items across the two venues,
`order` validates a basket, prices it per fulfilment method and returns the
venue's own rail plus its deep link. `cvm-registry` can now render that menu on
the public dashboard (`site/menu.json`, a capture of exactly this tool).

What is still missing, in the order that matters:

| # | Gap | Whose | Blocks |
|---|---|---|---|
| **G-c** | **Options are not served or validated.** `order` accepts `options?: Record<string, unknown>` and does nothing with it; `menu` publishes `option_group_ids` but no group content. | ours | a real basket (a burger needs its sauce and its size) |
| **G-d** | **Nothing can be paid.** No settlement code exists anywhere in the repo. | ours-as-merchant | any paid order |
| **G-e** | **Nobody confirms.** Neither venue exposes an order API, webhook or account. No order id, no status, no receipt. | theirs | a *completed* order. No code-only answer |
| **G-f** | **Merchant of record + DE 19 % pass-through.** | commercial | the first paid order (ADR-0004 decision 4) |
| **G-b** | **relay2 cannot carry the menus**: strfry `maxEventSize` 65536 vs doppelt 66045 / pizza 76965 B. Primal carries them; our own relay does not. | ours (infra) | reachability, not correctness |

## Track D — Options resolution (Stage 2, ours, no new decisions)

**The data already exists.** `venues/*/venue.json` carries `menu.option_groups`
and every item carries `option_group_ids` — pizza 78 of 112 items, doppelt 18 of
76. Nothing needs sourcing; it needs an adapter, a schema and a price rule.

**The trap is that the two venues describe options differently.**

- **doppelt** — flat and absolute:
  `{ id, name, required, max_count, multi_select, options: [{ id, name, price, available }] }`
  (5 groups: sauces, extras, sizes, special requests).
- **pizza** — level-dependent:
  `{ id, name, required, max, multi_select, type: "MultipleEnum", price_level_dependent: true,
     options: [{ id, name, list_price, price_level1, price_level2, discounted_price, … }] }`
  (18 groups, some with 28 choices). The delta depends on the **item's own price
  level** (`price_level_used`, e.g. `size2`) and there are discounted variants.

Guessing that yields wrong totals, silently. So the rule is the same one that
already governs money in this project: **the delta is read from the venue's own
numbers for that item, never computed.**

### Acceptance criteria

1. **`menu` publishes the option groups** a client needs to draw the choices:
   per item, the groups it offers (id, name, required, multi-select, min/max,
   and each choice's id, name, availability and its price for that item).
2. **`order` validates every choice** against the item's own group list: the
   choice belongs to that group; a `required` group is present; `max_count` /
   `max` is respected; `multi_select: false` takes at most one; an unavailable
   choice is refused. Unknown group or choice **fails loud** — never ignored.
3. **Options are priced from served data** for that item's price level, and the
   line total and basket total are the sum of served numbers.
4. **An ambiguous `sku` is refused** (already the rule; restated because options
   make it easier to hit) and items are addressable by the venue `id`.
5. **The transport is exercised**: one end-to-end run over a real relay with a
   basket that carries options, asserting the total against the venue's own
   numbers.
6. **The announcement schema follows**: `order.items[].options` documented in
   `docs/spec/service-inputs.md`, and the announced copy of the tool schema kept
   in sync with the served one (`tools/venue_to_announcement.ts` vs
   `services/restaurant-cvm/server.ts` — the drift that PR #14 already fixed
   once; the announced-vs-served drift test must cover options too).

### Tests, RED first

- required group missing → refused, naming the group
- choice not in the item's groups → refused, naming both
- more than `max_count` / more than one for a single-select group → refused
- unavailable choice → refused
- level-dependent delta: the pizza size group priced at the item's own level
- a basket with options totals the sum of the served numbers, not a computed one

### Dashboard half (ADR-0005)

An `OptionPicker` component in the client catalog, and `BasketLine` carrying the
chosen options. The money rule is unchanged and non-negotiable: **the renderer
reproduces every option price from served data before painting it.** A spec may
select and format an option price; it may never state one. The option groups are
served data, so they are safe to render through the same catalog path already
shipped.

### Out of scope for Track D

- Any venue whose storefront we do not control: options change *what the venue is
  asked to make*, not who pays. This is independent of settlement.

## Track E — Settlement (Stage 3, ADR-0004 v2, gated)

The target is ADR-0004 option **B**: the CVM takes the payment and settles with
the venue. **Cashu first, bolt11 later.** `bitcoin-lightning-bolt11` must not be
declared before we can settle it — that rule already exists and this plan does
not relax it.

Shape: an `order.settle` tool that

1. requires the **`D12` ring proof** — the invoice must not be issuable outside
   the gate;
2. issues the payment request (Cashu NUT-04 quote; bolt11 later);
3. exposes the settlement state so the page can poll it;
4. produces the *placed-order* result **only** when the mint/node reports PAID.

The Cashu half is largely reusable: `routstr`/`mcp-cashu-exchange` already run
NUT-04 quote → PAID → mint ecash → redeem → verify-SPENT against a real mint
(16/16 e2e). The bolt11 half needs a node with inbound liquidity; signet for a
demo.

### The honest stop, stated up front

**A completed order at a third-party restaurant is not reachable by code alone**
— G-e. We can take money; we cannot make FoodAmigos or OrderYoyo confirm
anything. So:

- **v2 as it can honestly exist today:** invoice → PAID → *we place the order on
  the venue's rail or by hand* → order id and receipt are **ours**. That works,
  and it makes us the counterparty (G-f).
- **A genuinely completed, self-confirming order** needs **PLAN-0005 Track C** —
  our own counter, where settlement and confirmation are both ours. Recommended
  as the *first* place settlement is exercised, precisely because it is the only
  place where "paid" and "confirmed" can both be true.

### Gated on (not engineering)

- **G-f** merchant of record, what the receipt says, how the 19 % inclusive tax
  passes through — ADR-0004 decision 4, still OPEN, gates the first paid order.
- A venue agreement for option B (we are not their merchant of record for free),
  plus a refund / no-show / partial-fulfilment policy.
- relay2 `maxEventSize` (G-b) for reachability on our own relay — an infra
  window, carded separately.

## Recommended order of work

1. **Republish the two announcements** from `main` now that the Stage-1 schema is
   merged and the server is reachable (the live catalog still declares
   `[contact.phone, order.fulfilment]`; the repo declares `order.items` and
   `order.when`). Until this happens the new arguments are invisible to clients.
2. **Track D** (options): adapter → `menu` groups → `order` validation + pricing →
   `OptionPicker` → relay e2e. No commercial dependency; improves every basket.
3. **PLAN-0005 Track C** small counter, with **`order.settle` against Cashu** —
   the first place a paid order can honestly complete.
4. **Track E on a third-party venue** only after G-f is answered and consent is
   in writing.

## Open questions for the operator

1. **Option prices in the dashboard:** render the choice deltas on the menu card,
   or only in the basket? (Recommendation: in the basket only — the delta depends
   on the item's price level and a bare "+2.00" next to a product that has level
   variants would be wrong.)
2. **Track C first?** Confirming an order with a third party is not solvable by
   code (G-e). Do we accept "our receipt" as the v2 demo, or go straight to our
   own counter for the first honest end-to-end settled order?
   (Recommendation: our own counter first — it is the only version where every
   claim on screen is true.)
3. **Declaring `bitcoin-cashu` on the venue announcements:** not until a
   settlement path exists for that venue. Confirm the current `settlement: null`
   stays.
