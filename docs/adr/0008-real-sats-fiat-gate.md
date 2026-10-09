# ADR-0008 — Real sats, and no fiat spend before the sats have settled

- **Status:** **Accepted 2026-10-09** — operator decision on the first real order ("Real sats payment.
  The 2fiat contextvm should refuse to make fiat payments if it didn't receive the SATs first").
- **Date:** 2026-10-09
- **Decided:** the first Tier-B order settles in **real mainnet sats** (not `testnut.cashu.space`
  auto-pay), and the fiat rail is gated on that settlement: **no fiat payment may be made unless the
  corresponding sats payment has settled first.**
- **Tier:** docs/light
- **Depends on:** ADR-0004 (Lightning-settled venue order), ADR-0001 `D12` (mandatory ring gate).

## Context

The paid leg had been designed to prove itself against the test mint, which auto-pays: invoice ->
mint says PAID -> order advances, no money moves. That proves the plumbing but not the money.

`cvm-2fiat` (merged `53eacd5`, PR #5) is **the rail, not the card**, and this is load-bearing for the
decision:

- its tools are `card.rail_info`, `payment.quote`, `card.balance` (owner-only) and `docs`;
- it has **no `payment.authorize` / charge tool, ever** — 2fiat is an issuer portal whose API can read
  balance, list transactions and create/fund/freeze a card, but has **no endpoint that authorizes a
  payment** (the PAN/CVV sits behind a 6-digit OTP 2fiat emails);
- the money rule already exists in the written contract: *"No spend may happen before the caller's
  payment has settled"* — but today it only guards `card.balance`, sitting downstream of the kit's
  `ExplicitGate` (CEP-8): an unpaid call throws `payment_required` and the adapter is never entered.

The fiat-payment half lives in the **private, local** `2fiat-local-adapter`
(`docs/SCOPE.md`, status: SCOPED, not built). It defines `pay_checkout(url, max_amount)` in its
interface; `cvm-2fiat` deliberately never consumes it.

## Decision

1. The first real order takes **real sats** — mainnet, small amount, no auto-pay mint.
2. **The invariant is a settlement gate, not a promise:** the fiat path must be structurally
   unreachable until the sats payment is observed settled. Cashu receive and Lightning payment are
   FINAL — there is no un-pay — so the failure mode (sats settled, fiat leg then fails) is accepted
   and handled by a *manual* refund, stated in the contract.
3. The gate is enforced at the service boundary (the kit's `ExplicitGate` pattern), not inside the
   adapter: the adapter is never entered on an unpaid call. RED-first test required.
4. **Honest limit, recorded now:** no fully unattended fiat payment is possible on this rail. 2fiat
   exposes no authorize endpoint, the card material sits behind an emailed OTP, and 3DS/SCA is
   mandatory. A human completes the last step. Any plan that assumes "the CVM just pays the card"
   is wrong and must be rejected in review.

## Consequences

- **The invariant is currently unenforceable because the fiat-payment path does not exist.** There is
  nothing to gate: `cvm-2fiat` never authorizes a payment, and `pay_checkout()` is an unimplemented
  interface in a not-built private adapter. Scheduling a real sats payment before that path exists
  would hand the operator a system that can take sats and cannot spend.
- Order of work therefore matters: the gated fiat path and the real sats leg are **one** deliverable,
  not two.
