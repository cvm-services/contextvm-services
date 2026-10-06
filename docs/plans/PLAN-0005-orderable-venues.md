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
5. **Tool versioning is explicit — DECIDED 2026-10-06, amended, not deferred.** The
   discriminator is the venue's **declared settlement**, not a caller-supplied argument:
   `declared.settlement` (v1 — names the venue's own rail, handoff is a deep link) versus
   `payment.method` + a non-zero `cap` + a `pmi` tag (v2 — the CVM settles itself). A
   client distinguishes them from the announcement alone, which is what this criterion
   was for. `order.channel` stays an input **we do not require**: the caller cannot
   influence which rail the venue uses, so demanding it would be inflated appetite
   (register rule 2). The rail is returned in the order *result* and declared in the
   announcement. **Rejected:** implementing `order.channel` as a required argument.
6. Tests: `order.items` validated against the published menu (an unknown **or ambiguous**
   `sku` fails loud), per-method price selection, and the delivery-requires-address
   condition. RED first.
7. **The transport is exercised, not just the tool logic.** One end-to-end run against a
   real relay; a suite whose header says "no relay required" proves the schema, not the
   server.
8. **The announcement is republished** once the server is reachable. A schema change that
   exists only in the repo is invisible to every client.

## Track A — read-only prefill spike (SOON, parallel, 1 worker)

**Question:** do the venues' own storefronts accept cart/deep-link parameters that prefill
a basket? If yes, an `order` tool can hand over a **loaded cart with the customer's picks**
instead of a homepage — a far stronger ending, and still no money and no automation.

**Rules:** read-only. No account, no order placed, no payment, no form submission beyond a
URL. Timebox: one worker, one report. Evidence = the URL shape and what the page shows.

**Outcome either way is useful:** a no tells us the handoff ends at a plain link, which
bounds what any honest video can show.

**CLOSED 2026-10-06 — NEGATIVE. No storefront accepts a basket-prefill parameter.**

- **Doppelt Käse (FoodAmigos) — impossible.** The basket is a Redux `BASKET` slice
  (`addItem`/`addItems`, internal dispatch only). The bundle's only query-string consumers
  are `order_draft_uuid` (resumes an *existing* draft), `auth_grant`/`auth_token`, `search`
  (menu filter) and payment-redirect keys. `?items=331227:2`, `?cart=…`, `?add=…&qty=…`,
  `?product=…`, `?sku=…` each returned the identical 2138-byte SPA shell — ignored.
- **Pizza e Pasta (OrderYoyo/Next.js) — impossible.** The basket uuid is minted server-side
  (`POST /oyy-api/Order/restaurants/45842/basket/{uuid}`) and kept in `BASKET_SESSION`
  storage; `orderId` is a post-checkout route segment. Bundle grep found only UTMs,
  analytics and Sentry params.
- **Could not verify:** the pizza page's live rendered response to a query string —
  Cloudflare answered curl with 403 *"Just a moment…"*. Its `/_next/static/*` bundles
  served 200 and were fully inspected, so the verdict does not rest on the blocked fetch.
- **Not enumerated:** FoodAmigos' single-product deep-link path (a page link, not a basket
  prefill; does not change the verdict).

**Consequence:** an `order` tool can hand over a bare menu (or single-product) link — never
a loaded cart — on either rail. Track A produces no code and is closed; the honest video
ending stays "basket proposed + handoff link", and only Track C can reach a receipt.

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

## Stage 1 review follow-ups (independent verification of PR #13, 2026-10-06)

Confirmed by re-running the gates, not by the worker's summary: `deno task test` →
`59 passed / 0 failed`; `deno check` clean; menu sourced from `venue.json` (`menu.items`,
188 items); real `order` arguments (`venue_slug`, `items[]`, `fulfilment`, `when`) with
`ship.address` required iff `fulfilment == "delivery"`; zero settlement code in the diff.

Open items, in order:

1. **Ambiguous sku resolves silently.** Pizza has three skus serving *distinct* products —
   `36` = Bionade Ingwer-Orange €3.60 **and** Vitamalz €2.70 (different prices), `110` two
   different pizzas, `44` two different beers. `buildIndex()` keeps the first occurrence,
   so a basket can quote one product's price for another. Accept the venue item `id`
   (unique), or fail loud: `ambiguous sku: 36 (2 items) — pass id`.
2. **Relay transport unexercised.** `server_test.ts` runs the tool logic "directly (no
   relay required)". One live run is owed before a venue is called reachable.
3. **Pizza has no `prices_by_order_method` at all** (0/112 items; it stores one `price` +
   `service_method` + `price_levels`), unlike doppelt (76/76 items, four methods). The
   delivery-price fallback is honest but carries no venue price — Stage 2 must never quote
   that fallback as a price.
4. **Republish the announcements.** Live still declares the pre-Stage-1
   `required = [contact.phone, order.fulfilment]`; the new `order.items`/`order.when` are
   invisible to clients until republished. Merging the server PR alone does not make a
   venue orderable.
5. ~~Criterion 5 is not met as written.~~ **Resolved 2026-10-06** — criterion 5 was
   amended to name the declared settlement as the discriminator, and implementing
   `order.channel` as a required argument is explicitly rejected (see acceptance
   criteria). Nothing further owed here.
6. ~~Ambiguous sku resolves silently.~~ **Fixed** on `pr/venue-server` — a colliding sku is
   refused with the item ids and the products named, and items are addressable by the
   venue's own `id`, now published by `menu`. Five new tests, RED first
   (`59 passed | 5 failed` against `d331903` → `64 passed | 0 failed`).

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
