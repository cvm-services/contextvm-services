# RALPH LOOP — sats-paid food ordering: finish the project

You are running a **Ralph loop**: one task, then re-read this file, pick the next
task, repeat, until every task is `done` or `blocked` with a written reason.

Paste this whole file as your prompt. Do not summarize it back to me. Start working.

---

## 0. What this project is

A customer in Berlin-Steglitz pays a restaurant order in **Lightning sats**. The
sats settle into ecash at the Minibits mint. A **facilitator** then places the
real order at the venue's own online checkout and keeps a **21% margin**.

Three surfaces: customer PWA (`/order/`), facilitator console (`/console/`), and
the venue's own storefront (not ours).

## 1. Where everything lives

All repos are in the **`cvm-services`** GitHub org:

| repo | role |
|---|---|
| `cvm-orders` | order lifecycle: pricing, invoice, settlement sweep, queue, refund leg |
| `cvm-registry` | the PWA (customer + console) and the menu collector |
| `contextvm-services` | ADRs, venue records (`venues/<slug>/venue.json`), restaurant-cvm |
| `cvm-service-kit` | CVM library; contains `services/cvm-2fiat/` (the rail) |
| `2fiat-local-adapter` | **private** — the only code that reads a PAN/CVV. Local-only. |
| `mcp-cashu-exchange`, `merchant-routing-engine`, `napplet-trust-checkout`, `nosms` | supporting services |

Read `contextvm-services/docs/INDEX.md` first — it maps the whole thing.

Local clones: `~/repos/<repo>` and `/data/repos/<repo>`. Deploy target:
`testserver2` (`/opt/tollgate/cvm-orders`). Fleet governance lives in
`~/repos/hermes-orchestration` (AGENTS.md is binding).

## 2. Rules that override your instincts

- **TDD or it did not happen.** A failing test first, then the change, then green.
- **Never trust a worker's self-report.** Verify git state, deployed bytes, and
  live HTTP responses yourself. A probe that passes is not proof the code shipped
  — read the file **on the target host**.
- **Fail closed.** If you cannot prove a thing, refuse. Never invent a payment
  reference, a settlement, a URL, or a "done".
- **Card values never touch an agent context, a log, argv, env, disk, or the
  clipboard** (ADR-0013). Only `2fiat-local-adapter` may hold them, in memory.
- **Do not claim a vendor limit you have not measured.** See task R0 — the
  entire 2fiat plan hinges on a measurement nobody has actually taken.
- **Consolidate to the default branch.** A push is not done; a merge is. Public
  repos push to GitHub **and** ngit; private repos push to GitHub only.
- **A missing field is not a verdict.** Never report "unsupported" from an absent
  value — say "we did not record it".

## 3. Task order (do them in this order; later tasks depend on earlier ones)

---

### R0 — MEASURE: does 2fiat actually need a human 3DS step? **(do this first)**

**This is a measurement, not a build. Its outcome changes the plan.**

A prior gap analysis concluded "unattended card capture is impossible: 3DS +
Stripe Elements + hCaptcha". The operator disputes this for 2fiat specifically.
The dispute is legitimate: the fiat CVM's `payFiat` returns
`state: "requires_3ds"` **without ever attempting a capture**, so the claim was
never tested — it was assumed. Do not inherit the assumption in either direction.

**Do:**
1. Read `hermes-orchestration/docs/plans/GAP-openai-account-automation-2fiat-payments-2026-10-09.md`
   and `2fiat-local-adapter/docs/SCOPE.md` §7.
2. With Playwright (venv `~/.cache/pw-venv`), drive the real 2fiat wallet —
   session is a **token in the URL**: `https://2fiat.com/wallet/<TOKEN>/my-cards`
   (token from OpenBao `secret/data/fleet/2fiat`, field `token`; **never echo it**).
3. Answer, with recorded raw request/response shapes and **no card values**:
   - Does `POST …/prepaid-cards/topup/{cardId}` still return `checkoutLink`, and
     is the bolt11 retrievable behind it (BTCPay-style API) or only in the UI?
   - Is the card-details OTP surfaced by the API (`GET …/otp`, `POST …/details/{id}`)
     or is it email-only?
   - **On a real merchant charge, does 2fiat's card actually trigger a 3DS
     challenge, or does it authorize without one?** This is the crux.
4. For any UI/screenshot judgement (layout, "which control is the confirm
   button", whether a modal blocked the flow), use the vision model
   (`glm-4.6v` → serves `gpt-6-astra`) for spatial reasoning, and
   **record which model answered**.

**Rate limit: the 2fiat edge limiter is SHARED, not per-IP.** One request at a
time. Never burst. A burst previously blocked two separate hosts.

**Done looks like:** a written verdict — `3DS_STOP: human_required |
not_required | unmeasurable` — with the raw evidence, at
`contextvm-services/docs/2fiat-unattended-measurement.md`. If it is
`not_required`, say so plainly and revise the plan; if `human_required`, say that
plainly too and stop pretending otherwise.

**Blocked if:** the 2fiat session token is unavailable, or the account is
rate-limited. Then write the exact command and the missing input, and mark
blocked — do not proceed to R2's automation.

---

### R1 — REFUND: make losing money impossible **(the money-safety task)**

Today "refund" only flips a state label and sends a Nostr DM
(`site/console/app.js` `refund()` — its own notice admits "melt to origin is the
paid leg's job"). `src/rail.ts` has `meltQuote()` and `checkMelt()` (NUT-05), but
**no HTTP route calls them**. So a customer whose order is never placed keeps
nothing.

**Do (TDD):**
1. RED test first: an order whose sats settled, then placed-failed, must end with
   the sats **back at the customer's own invoice**.
2. Collect a **customer refund bolt11/lightning-address at order creation** and
   persist it. Without it a refund is impossible — you can only hold ecash.
3. `POST /orders/:id/refund` → `meltQuote({request: refund_bolt11})` →
   `checkMelt()` polling. Set state `refunding` → `refunded` **only when the mint
   says PAID**. Never on our own say-so.
4. Idempotency: exactly one melt per order. Two facilitators must not double-refund.
5. Define and record who eats the Lightning routing fee.
6. Auto-refund when placement fails or the placing SLA expires.

**Done looks like:** a test that proves no sequence of failures leaves sats
neither with the customer nor with food, plus a live refund executed on a small
real amount with the mint's PAID observed.

---

### R2 — AUTOMATIC STORE INTEGRATION (no store navigation for the facilitator)

The venue checkout (FoodAmigos) exposes `POST /order-drafts` — **the basket,
before payment** — then `/order-validations`, `/orders`, `/stripe/payment-intents`.
Extracted 2026-10-14; see `contextvm-services/docs/threebuddies-checkout-flow.md`.
Only **3** venues accept online payment today: `three-buddies-berlin`,
`doppelt-kaese-berlin`, `ristorante-matera-berlin`.

**Do (TDD):**
1. Build the basket server-side via `POST /order-drafts` from the customer's
   priced basket — this is the real "no navigation" win and needs no card.
2. Hand off with the basket already populated. Measure honestly where it stops.
3. If placing the order requires a Stripe token minted in the customer's browser
   (Elements cross-origin iframe) or an hCaptcha solve, **record that as the
   measured ceiling** — "we prefill, a human confirms payment" — and do not
   pretend otherwise. Do NOT attempt to defeat hCaptcha or Stripe.
4. The facilitator console must show exactly what it can and cannot do: build
   basket → open hand-off → record confirmation. No dead buttons, no lying UI.

**Blocked if:** the venue API rejects a server-side basket without a browser
session. Then record the exact call and status and mark blocked.

---

### R3 — AUTOMATIC SETTLEMENT VIA 2FIAT (gated on R0)

**Do not start this until R0 has produced a verdict.** If R0 says
`human_required`, build only up to the hand-off and say so. If R0 says
`not_required`, build the full chain.

**Do (TDD):**
1. A `topup` tool on the 2fiat CVM implementing the **measured** contract:
   `POST /api/v1/prepaid-cards/topup/{cardId}/check-availability` `{topupValue}`
   then `POST /api/v1/prepaid-cards/topup/{cardId}` `{topupValue, selectedMethod:"BTC-LN"}`.
   Fee is 6.5% — verify arithmetically, do not hardcode a belief.
2. Retrieve the bolt11 behind `checkoutLink` and pay it with the **NUT-05 melt**
   using the customer's settled ecash. This is the leg that burns the sats.
3. Orchestrate: gate (sats settled) → melt → topup → card pays venue. Extend
   `GET /orders/:id/melt-plan` from *reporting* readiness to *executing*.
4. Card stays unfunded until this works; a top-up with no melt behind it wastes
   the customer's money. Order the steps so sats move **last**, never first.
5. 3DS: if R0 found it applies, the honest resting state is `human_required` —
   surface it to the facilitator with a one-tap continue, never fake a success.

---

### R4 — MAKE THE GATES REAL

1. **NIP-98 server-side verification** on `cvm-orders` (the console already signs
   and attaches a challenge; the server does not verify it). Currently a known,
   documented gap in the console.
2. Every open card on the `contextvm-services` board that is a completion
   leftover: `t_4549a32f`, `t_c9a94df7` (deploy cvm-orders main to production),
   `t_a63cf51a` (serve Three Buddies live), `t_cc2809fb`, `t_d790103d`,
   `t_8b3e65c3`, `t_f2a6f901`, plus the venue-adapter triage cards
   (`t_32d4763c`, `t_4fd9c215`, `t_46c41e69`, `t_3295d44e`, `t_3e791731`).
   Work the ones reachable from this project; leave the rest with a note.

---

### R5 — FRESH-CLONE VERIFICATION

`cvm-registry` e2e must run from a clean clone in CI (`t_e2a7400c`). A suite that
only passes on the author's machine is not a suite.

---

## 4. Every task's definition of done

Code/risky tier — all of these, or it is not done:

1. A failing test was observed before the change (say so with the output).
2. The full suite passes; coverage ≥ the repo's `.coverage-threshold` (default 80%).
3. Docs updated in the same commit as the code.
4. A cold cross-family review returns APPROVED and is **published** to the PR
   (a `github.com/.../pull/<N>` URL), citing `reviewer_model:`.
5. **Merged to the default branch** — a bare push does not count. Public repos
   also pushed to ngit; verify with `git ls-remote` on both.
6. IA/deploy changes additionally: executed against the real node, post-condition
   read back **from the node**, and state plainly which targets you did NOT run.

Docs/light tier: tests if present, pushed; review advisory.

## 5. Working agreement

- Keep `PROGRESS.md` at the worktree root: one line per cluster —
  `finding → status → files touched`.
- Write `REPORT.md` before your final reply; point at it.
- Commit and push after every verified milestone. Never hold a push for the end.
- If you hit a cap or a wall, write exactly where you stopped and list the
  **remaining steps as a numbered list**. Never claim a commit, push, test, PR or
  upload you did not observe.
- If a task cannot be done honestly (a vendor forbids it, a gate is upstream), the
  correct output is `blocked` with the measured reason — that is a success, not a
  failure.

## 6. Start

Begin with **R0**. It is a measurement. Report its verdict before starting R1.
