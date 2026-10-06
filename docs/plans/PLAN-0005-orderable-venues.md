# PLAN-0005 — Orderable venue CVMs: from a deep link to a completed order

- **Status:** **Approved** 2026-10-06 — operator chose **all three** tracks (A, B, C).
- **Urgency:** SOON. No money is lost while it waits; tracks B's build is blocked on
  decisions that are commercial, not technical.
- **Depends on:** ADR-0004 (pickup / settlement), ADR-0001 (`D5` venue's rail settles in
  v1, `D12` ring gate, `D2` tags), `docs/spec/service-inputs.md` (the field register),
  `deprecated`: nothing.
- **Supersedes nothing.**

## The finding that reframes the ask

**A venue CVM is currently a signed announcement and nothing else.**
`services/restaurant-cvm/` contains only the ring-signature trust module —
`trust/{gate,lsag,prover,curve,trustset}.py`, `trust/policy.json`,
`trust/sets/burger-vendors-berlin.json`, plus its own tests. There is **no server, no
MCP wiring, no tool handler**. A working CVM server exists next door to model on
(`~/repos/cvm-kalman-server/server.ts`, `~/repos/hermes-insights-cvm/src/server.ts`).

Consequence: the zero-argument `order` tool is not a limitation anyone chose — it is a
**placeholder for a service that was never built**. Nothing answers a call to it. So
"get to a completed order" starts one level below the schema: there has to be a running
service before there can be an argument list.

## The four gaps, and whose they are

| # | Gap | Whose | Notes |
|---|---|---|---|
| **G0** | **No server.** Nothing serves the announced tools. | ours | the foundation; everything else sits on it |
| **G1** | **The basket cannot be built.** `order` is `properties: {}`, `additionalProperties: false`; only an aggregate summary is published (`item_count`, `min_price`, `max_price`, `prices_by_method`). | ours | **the data already exists**: 188 items (doppelt 76, pizza 112), every one carrying `sku`, `prices_by_order_method`, `allergens`, `option_group_ids`, `available` |
| **G2** | **Nothing can be paid.** Either we drive the venue's own rail (no API, no agreement → automating someone else's checkout needs their written blessing), or the CVM settles itself (then `payment.method` stops being optional, `cap` goes non-zero, a `pmi` tag and the `D12` ring gate apply, and German merchant-of-record lands on us). | theirs, or ours-as-merchant | the fork that needs sign-off |
| **G3** | **Nobody confirms.** A *completed* order needs an acceptor returning an order id + status. Neither venue exposes an order API, webhook or account to us. | theirs | no code-only answer; this is why track C exists |

The register has carried `order.items`, `order.when`, `order.channel`, `payment.amount`
and `payment.method` since day one, unused — the same shape as the `ship.address` defect
(the register had the words; the glue ignored them).

## Stage 1 — common to every track (starts now, no new decision, no new vocabulary)

Acceptance criteria:

1. **A venue CVM server exists** in `services/` modelled on `cvm-kalman-server`; it answers
   `tools/list` and `tools/call` over the existing CVM transport, and refuses cleanly when
   its trust gate refuses.
2. **`menu` returns real line items** — `sku`, `name`, `prices_by_order_method`,
   `available`, `allergens` — sourced from `venues/*/venue.json`, not retyped. 188 items
   across the two venues must round-trip.
3. **`order` takes the register's real arguments**: `order.items[]` of `{sku, qty,
   options?}`, `order.fulfilment` (`pickup|delivery|dine_in`), `order.when`, `order.notes`;
   `ship.address` required **only** when `order.fulfilment == "delivery"` — the conditional
   the register's flat AND list cannot express, enforced in code.
4. **Nothing over-claims.** With no settlement implemented, the tool returns a basket +
   the venue's rail and its description says checkout happens on the venue's page. A tool
   that takes items and cannot be paid must not read as "order placed".
5. **Tool versioning is explicit** — `order.channel` names the rail the order will land
   on, so a v1 handoff and a v2 settling CVM are distinguishable from the announcement
   alone.
6. Tests: `order.items` validated against the published menu (an unknown `sku` fails loud),
   per-method price selection, and the delivery-requires-address condition. RED first.

## Track A — read-only prefill spike (SOON, parallel, 1 worker)

**Question:** do the venues' own storefronts accept cart/deep-link parameters that prefill
a basket? If yes, an `order` tool can hand over a **loaded cart with the customer's picks**
instead of a homepage — a far stronger ending, and still no money and no automation.

**Rules:** read-only. No account, no order placed, no payment, no form submission beyond a
URL. Timebox: one worker, one report. Evidence = the URL shape and what the page shows.

**Outcome either way is useful:** a no tells us the handoff ends at a plain link, which
bounds what any honest video can show.

## Track C — our own counter (SOON, the demonstrable completed order)

A venue **we** run: a small counter CVM that takes the basket, settles, and returns an
**order id + receipt**. Zero third-party consent needed, so this is the only track that can
produce a genuinely completed order — and therefore the only one that can end the video at
a receipt rather than a homepage. Start deliberately small (a drinks/snack counter at a
known location; synthetic inventory is fine as long as the settlement is real and the
declaration says what it is).

Acceptance: an order placed through the CVM is paid, confirmed with an order id, and the
operator can see it; the announcement declares `payment.method`, a non-zero `cap` and a
`pmi` tag; the `D12` ring gate guards the settlement step.

## Track B — Lightning/Cashu reseller (BLOCKED on decisions)

The customer-facing "pay for my pickup order with Lightning" flow, fronting a third-party
venue. **Do not write code before these are answered** — each one has killed this pattern
before:

1. Is a third-party venue's consent realistically available, or is track C the honest
   target?
2. Rail: **bitcoin-cashu** (easier reconciliation and refunds, matches `nosms`'s `pmi`
   posture) or **bitcoin-lightning-bolt11** (what a customer's wallet expects)?
3. Who is the **merchant of record** for a German sale, and does that need an entity before
   the first paid pickup order?
4. Written policy for refunds, no-shows, cancelled items and partial fulfilment — we would
   hold customer money before the food exists.

## Non-goals

- Declaring `payment.method` or any Lightning capability before a CVM genuinely settles.
- Per-item machine ordering without a settlement story (`payment` declared and never
  collected — the inflated-appetite failure again).
- Driving a third party's checkout — with or without an account — before their blessing.
- Changing `D5` for the v1 deep-link venues. They stay honest: discovery + handoff.

## Open questions

1. For track C, where is the counter and what does it sell? (Synthetic is fine; real
   settlement, honest declaration.)
2. Does track A's answer change the video's endpoint? If a prefilled cart is possible, the
   existing recording should be re-shot to end there.
3. Does `order.items` become a required *tag* (`cvm:req:order.items`) once the server can
   accept a basket — the register's open question 3.

## References

- `services/restaurant-cvm/trust/` — the ring gate that already exists.
- `~/repos/cvm-kalman-server/server.ts` — the server pattern to model on.
- `venues/*/venue.json` — the 188 items with `sku` + `prices_by_order_method`.
- `docs/adr/0004-lightning-settlement-pickup.md` — options A/B/C and their costs.
- `docs/spec/service-inputs.md` — `order.*`, `payment.*`, tiers, class values.
