# PLAN-0007 — Facilitated orders: from approved mockups to a working demo

- **Status:** **Approved 2026-10-08** — operator: *"please schedule all of this work
  with soon priority. Lets schedule it with your recommendations and soon priority.
  We can always make changes later once we have a working demo. Please just merge
  your work when you think its ready, don't wait for me to review it."* Mockups
  approved the same day (*"yes these mockups look good"*).
- **Date:** 2026-10-08
- **Urgency:** **SOON** — operator-classified. No money is lost while it waits; the
  build is blocked on nothing further (all decisions below are taken).
- **Supersedes in part:** PLAN-0006 Track E (settlement becomes facilitator-mediated)
  and its Track C question (own-counter deferred, not needed for v1). PLAN-0006
  Track D (options) stays and is absorbed as T5 here.
- **Depends on:** ADR-0001 (discovery/trust), ADR-0004 (option **B**, Cashu before
  bolt11), ADR-0005 (presentation is client-side), and the approved mockups
  (`cvm-registry` PR #17, merged `82ae1fd`).

## Goal

A **working end-to-end demo**: a customer browses a Berlin venue, builds a basket,
pays in sats, and a **facilitator** places the order at the venue in fiat and
confirms it — with the customer seeing every step. Two personas, one product.

## Decisions taken (recorded; operator accepted the recommendations)

| # | Decision | Taken |
|---|---|---|
| D1 | Goal restatement: *facilitated orders at any venue* (not "via restaurant APIs") | ✅ necessary restate — G-e is structural, not fixable |
| D2 | PLAN-0006 Track E amended to facilitator settlement; Track C deferred | ✅ this document |
| D3 | Fee model: **flat %** for v1 (8 % in mockups), per-venue override later | ✅ |
| D4 | Facilitator v1 = **the operator** (one human, own queue) | ✅ multi-facilitator deferred |
| D5 | Customer app **grows the registry origin** (same host, same catalog) | ✅ |
| D6 | Settlement: **routstrd mint**, NUT-04 quote → PAID; refunds melt to origin; first-order cap ≈ 50 € | ✅ routstrd path already 16/16 e2e |
| D7 | Consolidation leftovers P2/P5/P6/P7/P10 | ✅ yes to all five |
| D8 | nosms PR #1 (LNURL adapter) | ✅ merge |
| D9 | Option prices rendered **basket-only** (level-dependent deltas) | ✅ |
| D10 | Track C own-counter | ✅ **deferred** — facilitator model makes it unnecessary for v1 |
| **D11** | **Client vehicle: thin PWA, same origin, no fork, no embedded wallet; facilitator console with Nostr-auth; Android deferred** | ✅ see ADR-0006 below |

### D11 in one paragraph

The customer app never holds money: the paid leg issues a **bolt11 invoice**
(routstrd NUT-04) that **any** Lightning wallet pays — so v1 needs no wallet
internals, no keys, no custody. Rejected: a **native Android app** (slowest
iteration, build/sign/distribute burden, and installed-PWA web push already
covers Android Chrome + iOS 16.4+; revisit only for a Play listing) and a **fork
of `cashubtc/cashu.me`** (MIT, 217★, Quasar PWA + Capacitor — verified; but its
information architecture is inverted vs ours: their home is balance/send/receive,
ours is venues/menu/basket, so forking means ripping out most screens and
carrying an unmergeable diff against an active upstream — permanent fork tax for
plumbing we do not need). cashu.me stays as **MIT reference** for cashu-ts
patterns, and the **Capacitor/TWA wrap of our own PWA is the deferred Android
path** (the pattern is proven by that very repo). Console auth =
**sign-in-with-Nostr** (sign a challenge with the facilitator npub) — no password
infrastructure, consistent with the rest of the stack.

## Tracks and the card map

| # | Track | Deliverable | Depends on |
|---|---|---|---|
| **T1** | **Order-state backend** (gap G-h) | Service holding the order lifecycle `paid → placing → placed → ready \| refunded`, a poll API for both UIs, Nostr-auth challenge for the console. **New repo `cvm-services/cvm-orders`** — deliberately *not* inside `cvm-registry`, whose cache-only, read-only invariant must stay intact | — |
| **T2** | **Paid leg** (gap G-d′) | `order.settle`: NUT-04 quote → invoice shown → **PAID-gated** transition in the T1 store; refund = melt to origin; cap ≈ 50 € | T1 (store) · existing card `t_8b3e65c3` |
| **T3** | **Customer PWA** at `cvm.orangesync.tech/order/` (gap G-g) | The 6 approved screens, static, catalog-constrained (ADR-0005): venues → menu → options → basket → invoice QR → status timeline polled from T1 | T1 (status API) · T2 (invoice) |
| **T4** | **Facilitator console** at `/console/` | The 3 approved panes: paid-basket queue with 5-min SLA, placing screen (venue checkout side-by-side + record venue order no./ETA), settlements (fees kept, fiat spent, refunds owed) | T1 · T2 |
| **T5** | **Options** (gap G-c, ex-PLAN-0006 Track D) | Adapter → `menu` option groups → `order` validation + level-aware pricing → option picker in T3 | T1 (indep. of settlement) |
| **T6** | **Hygiene** | `t_b4643299` vps2 redeploy (kit PR #7) · `t_3c048cb9` kit ngit-CI lane · menu re-capture policy (captures are 2026-10-06) · on-disk `site/catalog.json` rebuild (3 days stale; live one is fresh) | — |

**Build order:** T1 → T2 → T3 → T4, with T5 in parallel once T1 lands, T6
independent. T1 first because *neither* UI can tell the truth without it.

## Non-goals (explicit)

- Native Android app; iOS app.
- Forking or embedding cashu.me; **any** client-side key custody in v1.
- Multi-facilitator (auth/onboarding/trust for third parties).
- Venue order APIs, webhooks, or written venue consent (structurally unavailable — G-e).
- Track C own-counter (deferred by D10).

## Standing operator instructions for this workstream

1. **Merge on your own judgement** — do not wait for operator review.
   (*"Please just merge your work when you think its ready, don't wait for me to
   review it."*) This replaces the operator-merge gate **for this workstream only**;
   the fleet's code gates (TDD, tests green, cross-family review, `consolidated`)
   are **unchanged** and still block completion.
2. Urgency **SOON** for all cards in this plan.
3. Changes are expected later: *"We can always make changes later once we have a
   working demo."* Prefer the smallest honest demo over speculative generality.

## Honest stops (unchanged, restated)

- A third-party restaurant still cannot self-confirm. The **facilitator** is the
  confirmation, by design — that is a person doing work, and the UI says so.
- Announcements keep `settlement: null` until a settlement path exists **per
  venue** (PLAN-0006 Q3).
- Menus are **captures**, not live feeds; staleness policy lands in T6.
