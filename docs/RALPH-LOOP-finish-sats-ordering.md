# RALPH LOOP — sats-paid food ordering: finish the project

You are running a **Ralph loop**: take one task, then re-read this file, pick the
next, repeat, until every task is `done` or `blocked` with a **measured** reason.
Re-read this file after EVERY task — it is the only durable state. Do not carry
state in your context window.

**§0 is measured fact. Everything in §0 was verified with real tool output. Do not
re-derive it and do not contradict it. Anything NOT in §0 — especially any claim
that something is "impossible" — is an unmeasured assumption and must be MEASURED,
not built around. This plan has already been wrong once that way (§0/R0).**

---

## §0 MEASURED STATE

### R0 — the 2fiat human-step question: MEASURED. The prior claim was WRONG.

We documented *"unattended card capture is impossible at 2fiat because of 3DS."*
It was **never measured** — the `pay` tool returned `state: "requires_3ds"`
WITHOUT ever attempting a capture, so the wall was asserted. Our own `SCOPE.md`
repeated it as fact. It was then measured across 4 live runs
(`2fiat-local-adapter/docs/R0-3DS-MEASUREMENT.md`, commit `5bdc6d0`):

```
3DS_STOP: not_required     # card-DETAILS stage
spend-path: UNPROVEN       # separate question, NOT answered
```

- Auth is `POST /api/v1/auth/exchange` — token-in-URL, no password, no 2FA.
- Card list and card **details** return with **no OTP, no 3DS, no challenge, no
  SMS, no email**.
- **BUT** `cardNo` comes back **MASKED** (`5257 **** **** 9166`) — so the details
  call alone cannot complete a merchant checkout. Full PAN + CVV never appeared.
- `capabilities()` reports `can_authorize: False` — authorisation may be 2fiat-side.
- Transaction log shows repeated authorisations **FAILED** on a **0.38 USD** card —
  consistent with **insufficient funds, NOT a 3DS stop**.

⇒ Do NOT build around a 3DS stop. Do NOT claim automation is solved either.

### R1 — the refund leg: THE MONEY NOW MOVES (`cvm-orders b35f143`)

**CORRECTION — earlier revisions of this file said "R1 SHIPPED" and that was FALSE
for several rounds.** `reconcileRefund` quoted a melt and then polled it forever;
nothing POSTed proofs to `/v1/melt/bolt11`, so no melt could ever settle and the
customer still received nothing. The suite stayed green because the fake rail set
`state = "paid"` by assignment. **A quote is not a payment, and a shape test is not
a spend test.**

What is now true, verified against a **real mint** (testnut, no funds):

- `src/melt_authorize.ts` (new) — NUT-05 step 2, the step that spends. Refuses an
  underfunded melt BEFORE any network call; requests NUT-08 change so an
  over-reserved fee is not silently kept; a 200 is never read as PAID; an HTTP error
  is never a licence to retry with bearer proofs.
- `src/refund.ts` — the spend is wired behind the durable latch, and **only the latch
  winner spends**. A rail that cannot spend fails loudly instead of quoting forever.
- `refunded` only on the mint's PAID; `paid -> refunded` removed; `claimSettlement`
  refuses sats with no refund target (`no_refund_target`).
- **Live proof:** mint -> melt-quote -> AUTHORISE real proofs -> the mint says `PAID`.
  228 passed / 0 failed. `refund.ts` 84% line / 100% branch; `melt_authorize.ts`
  82% line / 100% branch.

**THREE LIVE-ONLY DEFECTS were found doing this — every one mirrored by our own
doubles, which is why they survived several rounds of green suites:**

1. **Outputs need the keyset `id`.** Mint outputs without it → 422
   `missing field 'id'`. Melt outputs without it → 400 `Invalid payment request`
   (isolated by experiment: no outputs → PAID; outputs WITH id → accepted; outputs
   WITHOUT id → `Invalid payment request`). `blankOutputs()` computed the id and the
   request silently dropped it.
2. **The secret's encoding was wire-inconsistent.** A real mint hashes the UTF-8 of
   the secret STRING it receives; we blinded over raw entropy and shipped a different
   string, so `Y` differed and the mint refused a proof it had just signed
   (`Token not verified`). Measured three ways: raw-bytes+base64url → refused;
   utf8(base64url)+same string → **PAID**; utf8(hex)+same string → **PAID**. The rule:
   **the bytes hashed at blind time must be the UTF-8 of the wire string.**
   (`wireToSecret` now returns `utf8(wire)`.)
3. **Two assertions had pinned the bug as a requirement** — `ecash_client_test`
   demanded a 64-char hex secret, and the fake mint hashed the same `Uint8Array` we
   blinded with. The double agreed with our mistake by construction. It now takes the
   WIRE secret as a string and hashes it the way a real mint does.

**STILL OPEN — R1c: the PRODUCTION half.** The mechanism is proven; only production
value is not. testnut is cdk 0.18.1 and settles its own invoices, so the remaining
proof is the same round-trip against **Minibits at real value with a real external
invoice**, which needs funded ecash the operator must supply.

### R1b — real-mint contract: PROVEN money-free (`cvm-orders 1aba105`)

A live contract test against the real Minibits mint
(`tests/mint_contract_live_test.ts`, opt-in via `CVM_LIVE_MINT_TESTS=1`) proved:

- The mint advertises NUT-04 + NUT-05 for `bolt11`/`sat`.
- **A mint quote needs a NUMERIC amount.** `{"amount":"21"}` → 400
  `Invalid payment method`; `{"amount":21}` → 200 with a real invoice. cdk-mintd
  reports the type mismatch misleadingly. Our mint path had never been run against
  a real mint — this is what a fake rail structurally cannot catch.
- **Our melt shape is CORRECT.** `{ request, unit: "sat" }` (no amount — the mint
  reads it from the invoice) → 200, returning the exact fields `rail.ts` consumes:
  string `quote`, numeric `expiry`, `state: UNPAID`, `unit: sat`. The response
  **echoes back the invoice we supplied**, so a refund cannot be quoted to the
  wrong destination.
- `checkMelt`'s state map holds; an **unknown** quote id → 400, **not** a 200 that
  could let a phantom refund read as settled.

**STILL OPEN — R1c: the FUNDED half.** Proving sats actually arrive back at a
customer requires a real melt with real proofs, which requires funded ecash the
operator must supply. No funded ecash exists on the box today.

### Infra — measured, blocked on operator

- **Vault:** the node's AppRole is `fleet-node-x280` with policies
  `["default", "fleet-node-x280"]`. AppRole login **succeeds (200)**, but reading
  `secret/data/fleet/2fiat` returns **403** — the policy lacks that path. Writing a
  policy needs a token with `sudo` on `sys/policies`; the node has no `VAULT_TOKEN`
  and no `bao` CLI. **Not fixable from inside the node, by design (ADR-0020).**
- **Org:** `merchant-routing` transfer-out and the stale `2fiat-local-adapter`
  description both need **org-owner** rights (the acting account has `push`, not
  `admin`, and org role `member`; both calls return 404).
- Cleanup: `role-id.vps-bak` / `secret-id.vps-bak` are stale AppRole creds sitting
  beside the live ones.

---

## §1 What we are building

Customers pay **Lightning sats** for Berlin (Steglitz) restaurant orders; sats
settle as ecash at the Minibits mint; a **facilitator** places the real order at the
venue's own online checkout and keeps a **21% margin**.

Operator's three deliverables:
1. automatic settlement via 2fiat.com
2. automatic store integration via ContextVM (facilitator need not navigate the store)
3. **a working refund path** ← shipped (R1), shape proven (R1b); funded proof pending

Done = tested **end-to-end**: a human walks into a restaurant and buys food with sats.

---

## §2 Definition of done — ALL of it, every task

1. **TDD** — the test exists and was observed FAILING before the implementation.
2. **Tests pass** — the full suite, output verified, not asserted.
3. **Coverage ≥ 80%** on changed files.
4. **Cross-family review PUBLISHED** — post it to the PR. A same-family pass is not a review.
5. **Atomic commits** — one concern each, conventional messages.
6. **Consolidated to the DEFAULT branch** — "pushed a branch" is not done; verify with `git ls-remote origin <default>`.
7. **Dual-push** — GitHub **and** ngit, both verified via `git ls-remote`.
8. **Honesty contract** — never claim a commit/push/test/PR you did not observe in
   tool output. If budget runs out, state the step you stopped at and list the
   REMAINING steps as a numbered list. **Blocked with a measured reason is a
   SUCCESS.** Never fabricate output; a fake mint proves protocol shape, never money.
9. **PROGRESS.md** at the worktree root, appended per cluster
   (`finding -> status -> files touched`); **REPORT.md** before the final reply.

### Hard constraints

- **ADR-0013 (card custody):** card **VALUES** (PAN/CVV) never in an agent context,
  log, argv, env, disk, or clipboard. Only `2fiat-local-adapter` may hold card
  material, in memory. The **session token** is a *different* asset — resolvable via
  the fleet vault AppRole — but still never on argv and never logged.
- **`2fiat-local-adapter` stays PRIVATE** (`tests/test_repo_visibility.py`) and no
  token/PAN may be committed (`tests/test_no_token_material.py`).
- **2fiat's rate limiter is SHARED across hosts.** One request at a time. A burst
  previously blocked two machines. Never retry-storm.
- **Only venues with an ONLINE checkout are supportable.** Others are refused at
  `priceOrder` (`venue_not_supportable`).
- **`order_url` comes from committed venue RECORDS**, never the flaky relay capture.
- **Never again assert a wall you have not measured.** If you cannot measure it,
  say `unmeasurable` and record why.
- Layout: repos in `~/repos/<repo>` (+ `/data/repos` symlinks); worktrees in
  `~/worktrees/`, **never `/tmp`**. Deno 2.9.7; `export PATH="$HOME/.local/bin:$PATH"`.
- **Quota gate first** on any LLM-driven dispatch; never bypass it.

---

## §3 THE TASKS

### R1c — the FUNDED refund proof (do first; it is the money question)

R1b proved the shape; only real funds can prove the money moves.

- **Precondition the operator must satisfy:** funded ecash at the Minibits mint.
  Do not invent it. If there is none, leave R1c **blocked** with that reason.
- Given funds: build the proofs -> `meltQuote` -> supply proofs to `/v1/melt/bolt11`
  -> `checkMelt` until the mint says PAID. Record the mint's own evidence
  (quote id, payment preimage/hash) and the customer-side arrival.
- **Rules that must not bend:** `meltQuote` sends **no amount** (the mint reads the
  invoice); **only the mint may say PAID**; an unknown/expired state must THROW,
  never default to success.
- **Exit:** a real refund observed end-to-end with mint evidence, committed. Or a
  clearly-scoped blocked task naming exactly what funding it needs.

### R3 — settle via 2fiat (re-scoped by R0; do NOT assume a 3DS stop)

- **First, measure the SPEND path on a FUNDED card.** The details stage is ungated;
  whether a spend completes unattended is open. Model any new harness on
  `2fiat-local-adapter/tools/r0_measure_3ds_stop.py` (observation-only; never clicks
  a spend control unless the task explicitly says to spend, and only on a card the
  operator has funded for that purpose).
- Top-up contract (measured): `POST /api/v1/prepaid-cards/topup/<cardId>` with
  `{"topupValue":"N","selectedMethod":"BTC-LN"}` → `checkoutLink` with a bolt11 to
  pay; fee 6.5%.
- Build `topup` + card capture **only as far as measurement justifies**, then wire
  the orchestration: claim → melt → topup → card.
- **Exit:** `SPEND: unattended | human_required | unmeasurable`, with evidence, and
  automation built to exactly that verdict — no further, no less.

### R2 — automatic store integration via `POST /order-drafts`

- Basket prefill so the facilitator need not navigate the store. API mapped in
  `contextvm-services/docs/threebuddies-checkout-flow.md`.
- **Measure the ceiling honestly** — card fields live in Stripe cross-origin iframes
  and checkout is hCaptcha-gated. Record exactly how far a pre-filled basket gets.
- `submit: false`; **the human holds payment authority**.
- **Exit:** a CVM tool that prepares a basket for a supportable venue + a written
  statement of the measured hand-off point.

### R4 — make the gates real

- **NIP-98 server-side verification** — the console currently asserts identity; the
  server must verify the signed event itself.
- Board leftovers. Record the two org-owner items as **blocked-on-operator**; never
  silently drop them.

### R5 — fresh-clone CI verification

- Clone each repo clean, run the suite **off the author's machine**. Reproduce
  `cvm-orders`' 212 passed / 0 failed from a fresh clone, including the refund tests.
- Confirm the live mint tests **skip** by default and only run under
  `CVM_LIVE_MINT_TESTS=1`.

---

## §4 Progress log (append; never delete)

- R0 — DONE (`2fiat-local-adapter 5bdc6d0`). Measured; the 3DS claim was wrong for
  details. `not_required` for details; spend path unproven.
- R1 — **DONE for real** (`cvm-orders f1b51bd` spend leg, `b35f143` spendable
  proofs). Earlier entries said "SHIPPED" and that was FALSE: nothing POSTed proofs,
  so no melt could settle. Now verified against a real mint — mint -> quote ->
  AUTHORISE -> the mint says PAID. Three live-only defects found (keyset `id` on
  outputs, the secret's wire encoding, and two tests that had pinned the bug as a
  requirement). **A quote is not a payment; a shape test is not a spend test.**
- R1b — DONE (`cvm-orders 1aba105`). Real-mint contract money-free. **Caveat: it
  stops at the QUOTE**, so it could not have caught the spend defects; do not read
  "melt shape is CORRECT" as evidence that spending works.
- R1c — **BLOCKED (precondition unmet, measured)**. No funded ecash: the fleet wallet
  reports `balance_sats: 0`, and the box holds no cashu wallet/proof store. Operator
  must fund. Do NOT simulate a funded melt. **The MECHANISM is proven (R1); only
  production VALUE is unproven.**
- R2 — MOSTLY MEASURED, **blocked on one input** (`cvm-services e355530`). The
  contract is established from the server's own validation errors. **509 and 550 are
  BOTH real** — marketing payload says 509, ordering API is `550`
  (`/companies/550/menus`, 208 KB, 122 products keyed by exactly our id family:
  `1052491` = Curly Fries (vegan)). Still 500s, so the gap is a FIELD we are not
  sending, not a wrong id. Close it with the storefront's own draft body: dismiss
  `AKZEPTIEREN`, open `/speisekarte/threebuddies` (the landing page is NOT the
  ordering surface), add an item. Do NOT invent a `product_id`; do NOT read the 500
  as success.
- R5 — **DONE** (`cvm-orders 268c496`, `a21664f`). A fresh clone reproduces
  `228 passed / 0 failed` with no local state. Found there was **no CI at all**;
  `.coverage-threshold` enforced nothing. The gate is **fail-closed** — my first
  version scraped the pretty table, read an empty string, and silently PASSED.
- R4 — **the NIP-98 half was ALREADY DONE** (`cvm-services 9f1ac39`): real schnorr
  verification, nonce binding, freshness, request-binding, replay refusal,
  `NIP98_STRICT`, 10 passing tests. The plan's premise was **stale**; a worker
  following it would have re-implemented an existing security boundary. Do NOT
  re-implement. Remaining: board leftovers only.
- R3 — not started (needs a FUNDED card).
- Infra — vault policy + two org-owner items: blocked on operator. Cleanup: stale
  `role-id.vps-bak` / `secret-id.vps-bak` beside the live AppRole creds.
