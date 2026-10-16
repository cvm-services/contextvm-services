# RALPH LOOP — sats-paid food ordering: finish the project

You are running a **Ralph loop**: one task, then re-read this file, pick the next
task, repeat, until every task is `done` or `blocked` with a measured reason.
Re-read this file after EVERY task — it is the only durable state.

**Nothing in this file is an assumption any more. R0 was measured. Read §0 first:
one of our documented "walls" turned out not to exist.** Treat the corrected
picture below as the starting point, and treat any *unmeasured* claim — mine or
yours — as a task to measure, not a fact to build on.

---

## 0. MEASURED STATE (do not re-derive, do not contradict)

### R0 — the 2fiat human-step question: MEASURED, previous claim was WRONG

We documented "unattended card capture is impossible at 2fiat because of 3DS".
That was **never measured** — the `pay` tool returned `state: "requires_3ds"`
WITHOUT ever attempting a capture, so the wall was asserted. It was then measured
across 4 live runs (`2fiat-local-adapter/docs/R0-3DS-MEASUREMENT.md`):

```
3DS_STOP: not_required    # card-DETAILS stage
spend-path: UNPROVEN      # separate question, NOT answered
```

- Auth is `POST /api/v1/auth/exchange` — token-in-URL, no password, no 2FA.
- Card list and card **details** (`GET /api/v1/prepaid-cards/details/<cardId>`)
  return with **no OTP, no 3DS, no challenge, no SMS, no email**.
- **But** `cardNo` comes back **MASKED** (`5257 **** **** 9166`), so the details
  call alone cannot complete a merchant checkout. Full PAN + CVV never appeared.
- `capabilities()` reports `can_authorize: False` — authorisation may be 2fiat-side.
- The transaction log shows repeated authorisations **FAILED** on a **0.38 USD**
  card — consistent with **insufficient funds, not a 3DS stop**.

**Therefore: do NOT build around a 3DS stop. Do NOT claim automation is solved
either.** The honest state is "the human gate we believed in is absent; the spend
path is unproven". Task R3 below is where that gets settled.

### R1 — the refund leg: SHIPPED

`cvm-orders` `2f0f495` on `main` (GitHub + ngit verified identical). 212 passed /
0 failed; `src/refund.ts` 87% line / 100% branch. The refund melts NUT-05 to the
customer's own bolt11 and marks `refunded` **only on the mint's PAID verdict**;
`paid -> refunded` was removed; `claimSettlement` refuses sats with no refund
target (`no_refund_target`). **Its remaining gap:** no live-mint proof — the tests
use a fake rail that implements the real NUT-05 protocol.

### Repo consolidation: DONE

16+ repos in the `cvm-services` org, indexed in `contextvm-services/docs/INDEX.md`.

---

## 1. What we are building

Customers pay **Lightning sats** for Berlin (Steglitz) restaurant orders; sats
settle as ecash at the Minibits mint; a **facilitator** places the real order at
the venue's own online checkout and keeps a **21% margin**.

Operator's three deliverables:
1. automatic settlement via 2fiat.com
2. automatic store integration via ContextVM (facilitator need not navigate the store)
3. **a working refund path** ← shipped (R1); needs live proof

Done = tested **end-to-end**: a human walks into a restaurant and buys food with sats.

---

## 2. Fleet definition of done (ALL of it, every task)

1. **TDD** — the test exists and was observed FAILING before the implementation.
2. **Tests pass** — the full suite, output verified, not asserted.
3. **Coverage ≥ 80%** on changed files.
4. **Cross-family review PUBLISHED** — a same-family pass is not a review. Post
   the review to the PR.
5. **Atomic commits** — one concern each, conventional messages.
6. **Consolidated to the DEFAULT branch** — "pushed a branch" is not done. Confirm
   the default branch has it; verify the remote (`git ls-remote origin <default>`).
7. **Dual-push** — GitHub **and** ngit, both verified via `git ls-remote`.
8. **Honesty contract** — never claim a commit/push/test/PR you did not observe in
   tool output. If you run out of budget, state the step you stopped at and list
   the REMAINING steps. **A blocked task with a measured reason is a SUCCESS.**
9. **PROGRESS.md** at the worktree root, appended after each cluster
   (`finding -> status -> files touched`); **REPORT.md** before the final reply.

### Hard constraints

- **ADR-0013 (card custody):** card VALUES (PAN/CVV) never in an agent context,
  log, argv, env, disk, or clipboard. Only `2fiat-local-adapter` may hold card
  material, in memory. The **session token** is a different asset — resolvable
  via the fleet vault AppRole — but still never on argv or in a log.
- **`2fiat-local-adapter` stays PRIVATE** (`tests/test_repo_visibility.py`) and no
  token/PAN may be committed (`tests/test_no_token_material.py`).
- **2fiat's rate limiter is SHARED across hosts.** One request at a time. A burst
  previously blocked two machines. Never retry-storm.
- **Only venues with an ONLINE checkout are supportable.** Orders for others are
  refused at `priceOrder` (`venue_not_supportable`).
- **`order_url` comes from committed venue RECORDS**, never the flaky relay capture.
- Layout: repos in `~/repos/<repo>` (+ `/data/repos` symlinks); **worktrees in
  `~/worktrees/`, never `/tmp`**. Deno 2.9.7; `export PATH="$HOME/.local/bin:$PATH"`.
- **Quota gate first** on any LLM-driven dispatch; never bypass it.

---

## 3. THE TASKS

### R1b — prove the refund against a REAL mint (do this first; it is cheap)

The refund leg is shipped but only ever exercised against a fake rail. A fake that
implements the real protocol is a good test double, but it is **not** proof that
money moves.

- `src/rail.ts` already speaks real NUT-05 (`meltQuote`, `checkMelt`), so no new
  rail code is needed. `railFromEnv` reads `CASHU_MINT_URL`.
- Do a genuine melt to a bolt11 you control, against the Minibits mint, and record
  the mint's PAID verdict plus the preimage/payment evidence.
- Watch the rules: `meltQuote` sends NO amount (the mint reads the bolt11);
  `checkMelt` — **only the mint may say PAID**; unknown states THROW, they do not
  default to success.
- **Exit:** a real refund recorded, with the mint's own evidence, committed.
- **If it cannot be done** (no funded sats available), say so with the measured
  reason and leave the task blocked — do NOT simulate a success.

### R2 — automatic store integration via `POST /order-drafts`

Build the basket-prefill so the facilitator need not navigate the store.

- The FoodAmigos checkout API is mapped: `POST /order-drafts`,
  `POST /order-validations`, `POST /orders`, `POST /stripe/payment-intents`.
  Evidence: `contextvm-services/docs/threebuddies-checkout-flow.md`.
- **Measure the ceiling honestly.** The card fields live in Stripe cross-origin
  iframes and checkout is hCaptcha-gated — so record exactly how far a
  pre-filled basket gets before a human must act. Do not overstate.
- **Exit:** a CVM tool that prepares a basket for a supportable venue, plus a
  written statement of the measured hand-off point. `submit: false`; the human
  holds payment authority.

### R3 — settle via 2fiat (re-scoped by R0 — do NOT assume a 3DS stop)

R0 removed the assumed blocker without proving the path works. Settle it:

- **First, measure the SPEND path** on a **funded** card. The details stage is
  ungated; whether a spend can complete unattended is open. Use
  `tools/r0_measure_3ds_stop.py` as the model for observation-only harnesses
  (never click a spend control unless the task explicitly says to spend, and only
  on a card the operator has funded for the purpose).
- The top-up contract is measured: `POST /api/v1/prepaid-cards/topup/<cardId>`
  with `{"topupValue":"N","selectedMethod":"BTC-LN"}` returning a `checkoutLink`
  whose bolt11 must be paid; fee 6.5%.
- Build `topup` + card capture **only as far as measurement justifies**, and wire
  the orchestration: claim -> melt -> topup -> card. Record the verdict as
  `SPEND: unattended | human_required | unmeasurable`.
- **Exit:** the spend verdict recorded with evidence, and the automation built to
  exactly that verdict — no further, no less.

### R4 — make the gates real

- **NIP-98 server-side verification.** The console currently asserts identity; the
  server must verify the signed event itself.
- Board leftovers: the org-consolidation carry-over card, and the two
  org-owner-rights items (the `merchant-routing` transfer-out and the stale
  `2fiat-local-adapter` description) — these need the operator's admin rights;
  record them as blocked-on-operator rather than silently dropping them.

### R5 — fresh-clone CI verification

Clone each repo clean and run the suite **off the author's machine**. A suite that
only passes in one working copy is not green. Reproduce the 212-test result for
`cvm-orders` (and the refund tests specifically) from a fresh clone.

---

## 4. Progress log (append; never delete)

- R0 — DONE. Measured; the prior 3DS claim was wrong for details. `not_required`
  for details, spend path unproven. Committed `2fiat-local-adapter 5bdc6d0`.
- R1 — SHIPPED `cvm-orders 2f0f495`. Live-mint proof still outstanding (R1b).
- R1b — not started.
- R2 / R3 / R4 / R5 — not started.
