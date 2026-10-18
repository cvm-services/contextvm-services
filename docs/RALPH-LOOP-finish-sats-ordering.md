# RALPH LOOP — sats-paid food ordering: drive to completion

You are running a **Ralph loop**: take one task, then re-read this file, pick the
next, repeat, until every task is `done` or `blocked` with a **measured** reason.
Re-read this file after EVERY task — it is the only durable state.

**§0 is measured fact, verified with real tool output. Do not re-derive it and do
not contradict it. Anything NOT in §0 — especially any claim that something is
"impossible" — is an unmeasured assumption and must be MEASURED, not built around.**

**This project has been wrong NINE times in the same direction: a confident claim
falsified by measurement.** Every single one was found only by going to a real
mint, a real API, or a screenshot. The doubles agreed with our mistakes every time.
Treat that as the governing lesson, not an anecdote.

The nine, so a fresh window recognises the shape:
1. "3DS blocks unattended capture at 2fiat" — never measured; the OTP is API-gettable.
2. "R1 shipped, money-safety leg complete" — nothing POSTed proofs; no melt settled.
3. "R1c blocked on funded ecash" — it was blocked on code that did not exist.
4. "The secret is hex" — hex was fine; the bytes hashed must be utf8(wire string).
5. "4 sats is below a dust limit" — the mint's min is 1; the floor is elsewhere.
6. "The melt needs amount − 1" — the mint enforces inputs == outputs + fee_reserve.
7. "T14's mesh is unreachable" — only TCP/22 was tested; OpenBao :8200 answers.
8. "2fiat is down / rate-limited" — it was NAT64 hanging; IPv4 works in 0.7s.
9. "secret_test.ts has a pre-existing failure" — it needed --allow-write, my flag.

Every one of these was asserted with confidence and died on contact with a real
measurement. Assume the tenth is in this file too.

---

## §0 MEASURED STATE

### R0 — 2fiat human-step question: MEASURED; the prior claim was WRONG

We documented *"unattended card capture is impossible at 2fiat because of 3DS."*
It was **never measured** — `payFiat` returned `requires_3ds` WITHOUT ever
attempting a capture. Four live runs (`2fiat-local-adapter 5bdc6d0`,
`docs/R0-3DS-MEASUREMENT.md`) say:

```
3DS_STOP: not_required     # card-DETAILS stage
spend-path: UNPROVEN       # separate question, NOT answered
```

- Auth is `POST /api/v1/auth/exchange` — token-in-URL, no password, no 2FA.
- Card list and card **details** return with **no OTP, no 3DS, no challenge, no
  SMS, no email**.
- **BUT** `cardNo` comes back **MASKED** (`5257 **** **** 9166`) — so the details
  call alone cannot complete a merchant checkout. Full PAN + CVV never appeared.
- `capabilities()` reports `can_authorize: False`.
- The transaction log shows authorisations **FAILED** on a **0.38 USD** card —
  consistent with **insufficient funds, NOT a 3DS stop**.

⇒ Do NOT build around a 3DS stop. Do NOT claim automation is solved either.

### R1 — the refund leg: THE MONEY MOVES (`cvm-orders b35f143`)

**Earlier revisions of this file said "R1 SHIPPED" and that was FALSE for several
rounds.** `reconcileRefund` quoted a melt and polled it forever; nothing POSTed
proofs to `/v1/melt/bolt11`, so no melt could settle and the customer received
nothing. The suite stayed green because the fake rail set `state = "paid"` by
assignment. **A quote is not a payment; a shape test is not a spend test.**

Now genuinely working, verified against a **real mint** (testnut, no funds):

- `src/melt_authorize.ts` (new) — NUT-05 step 2, the step that SPENDS. Refuses an
  underfunded melt BEFORE any network call; requests NUT-08 change so an
  over-reserved fee is not silently kept; a 200 is never read as PAID; an HTTP
  error is never a licence to retry with bearer proofs.
- `src/refund.ts` — the spend runs behind the durable latch and **only the latch
  winner spends**; a rail that cannot spend fails loudly instead of looping.
- `refunded` only on the mint's PAID; `paid -> refunded` removed;
  `claimSettlement` refuses sats with no refund target (`no_refund_target`).
- **Live proof:** mint → melt-quote → AUTHORISE real proofs → the mint says `PAID`.
- 228 passed / 0 failed. `refund.ts` 84% line, `melt_authorize.ts` 82% line, both
  100% branch.

**FOUR live-only defects were found doing this — all invisible to the doubles:**

1. **A mint quote needs a NUMERIC amount.** `{"amount":"21"}` → 400
   `Invalid payment method`; `{"amount":21}` → 200.
2. **Outputs need the keyset `id`.** Mint without it → 422 `missing field 'id'`.
   MELT without it → 400 `Invalid payment request` (isolated by experiment:
   no outputs → PAID; outputs WITH id → accepted; outputs WITHOUT id → 400).
   `blankOutputs()` computed the id and the request silently dropped it.
3. **The secret's encoding was wire-inconsistent.** A real mint hashes the **UTF-8
   of the secret STRING it receives**; we blinded over raw entropy and shipped a
   different string, so `Y` differed and the mint refused a proof it had just
   signed (`Token not verified`). Measured three ways: raw-bytes+base64url →
   refused; **utf8(base64url)+same string → PAID**; **utf8(hex)+same string →
   PAID**. Rule: *the bytes hashed at blind time must be the UTF-8 of the wire
   string.* (`wireToSecret` returns `utf8(wire)`; `wireToRaw` for entropy.)
4. **Two assertions had pinned the bug as a requirement** — `ecash_client_test`
   demanded a 64-char hex secret, and the fake mint hashed the same `Uint8Array`
   we blinded with. The double agreed with our mistake by construction. It now
   takes the WIRE secret as a string and hashes it as a real mint does.

**R1c — DONE (`cvm-orders c7d0074`). THE PRODUCTION HALF IS PROVEN.**
Ran against the live Minibits mint with REAL sats from the treasury:

```
destination invoice: 6 sats | fee_reserve: 2 | inputs 8 = outputs 6 + fee 2
AUTHORISED. state=PAID change outputs=1
MINT VERDICT: PAID
```

Real sats → treasury NWC payment → real Minibits ecash → melted back out as a real
Lightning payment, with NUT-08 change returned. Four more live-only defects were
found reaching this: the melt quote's `fee_reserve` was being **discarded** by
`rail.ts` (so every melt guessed the fee and was rejected `11005`), plus the
mint's payment threshold (1 and 4 sats never settle, cost nothing when they fail;
**8 sats works** — the mint's own `min_amount` is 1, so the floor is in the broker
or the route, not the mint).

### R1b — real-mint contract: done, with a caveat (`cvm-orders 1aba105`)

`tests/mint_contract_live_test.ts` (opt-in `CVM_LIVE_MINT_TESTS=1`) proved NUT-04
+ NUT-05 for `bolt11`/`sat`, the numeric-amount rule, that our melt QUOTE shape is
correct and echoes the invoice, and that an unknown quote id → 400 (never a
phantom PAID).

**Caveat, record it:** this stops at the QUOTE. It could not have caught defects
1–4 above. Do not read "melt shape is CORRECT" as evidence that spending works.

### R2 — store integration: BLOCKED on a modal, five strategies failed

The `POST /order-drafts` contract is established from the server's own validation
errors (`docs/r2-order-drafts-contract.md`):

- `company_id` int, `method` ("pickup" bypasses the delivery block),
  `line_items[]` present, `line_items[].product_id` required.
- **509 and 550 are BOTH real**: the marketing payload says 509; the ordering API
  is addressed with **550** (`/companies/550/menus` → 200, 208 KB, 122 products
  keyed by exactly the id family our venue records carry: `1052491` = Curly Fries
  (vegan), 4.50 pickup / 5.50 delivery).
- The request passes EVERY validation rule and still **500s**, so the remaining
  gap is a **FIELD we are not sending**, not a wrong id.

**The blocker, measured:** a full-screen location modal
(`<div class="w-screen fixed inset-0 h-[100dvh]" style="z-index:4000">`) stays
open with a grey backdrop and **intercepts every click**. Its `Menü Anzeigen`
button is disabled by **CSS CLASS** (`text-brand-button-disab…`), not by the
`disabled` attribute — so `page.click` hangs forever, which read as "nothing
works". The `+` add controls DO exist (icon buttons, class
`absolute bottom-2 right-2 rounded-full w-8 h-8`, empty text — which is why a
text sweep finds nothing) but they sit unreachable behind the overlay.

**Tried and FAILED (do not repeat these):** text/keyword sweep; class-based
targeting; `radio.click(force=True)`; DOM-level `e.click()`; **headed Chrome under
xvfb with real mouse clicks** at the vision-measured radio position (955,301 24×24).
Modal stayed open, button stayed class-disabled, **zero draft requests captured**.
There is **no X button in the modal's DOM** (vision saw a ×, but no such element
exists in the queried set).

**SOLVED 2026-10-18 — the modal is no longer the blocker.** Acting on COORDINATES
measured by the vision consultant (`glm-4.6v`) worked first try where five selector
strategies failed:

```
before | modal: True  | btn class-disabled: True
click 1: selection circle (967, 328)
  after c1 | modal: True  | btn class-disabled: False   <- the radio TOOK
click 2: Menü Anzeigen (683, 1092)
  after c2 | modal: False | btn class-disabled: None    <- modal CLEARED
```

The lesson is reusable: **act on vision-measured screen coordinates, not selectors**,
for custom SPA controls. What remains for R2 is the draft body itself — one measured
click on a real `+` add control, then read the POST /order-drafts payload.

**NEXT APPROACH (untried):** act on **coordinates**, not selectors — screenshot →
`vision_analyze` (astra, `glm-4.6v` → `gpt-6-astra`) for the exact click target →
`mouse.click(x, y)`. If that also fails, the modal is not automatable and R2 must
be closed as **out of scope**: it is a convenience gap only. The human still types
card details into Stripe's cross-origin iframe (hCaptcha-gated), so R2 never
touches the money path.

### R3 — 2fiat settlement: THE SPEND QUESTION IS ANSWERED (`contextvm-services 431b9aa`, `4d68ebe`)

**Verdict: `SPEND: automatable in principle — capture call not yet written`.**
Reached for $0, with no charge attempted. The old blocker ("3DS") was wrong twice.

**MEASURED 2026-10-18 (Phase 1, $0):**

| Probe | Result |
|---|---|
| `POST /api/v1/prepaid-cards/pay` | **404 `product_not_found`** — resolves a card PRODUCT to buy, NOT a charge on an existing card |
| `POST /api/v1/prepaid-cards/details/{id}` | **200** → `cardNumber`, `cvv`, `expirationDate` |
| `GET  /api/v1/prepaid-cards/details/{id}/otp` | **200**, `{}` when none pending — the 3DS code is API-retrievable |
| `payments` / `transfers` / `payouts` / `withdrawals` | 404 |

**There is no charge-by-reference endpoint.** 2fiat exposes card VALUES or nothing.
So the original ADR-0013 constraints ("device-initiated only", "operator's mail is
in the loop") described a world that does not exist and are marked superseded in the
ADR itself.

**ADR-0013 AMENDED 2026-10-18** (operator decision): card values MAY be held — but
the preferred implementation stores nothing: the existing 2fiat token fetches
`details/{id}` **just-in-time**, so values exist only for the seconds of a charge.
Terms: at rest OpenBao only; in use memory-only then discarded; CVV single-use and
never persisted (PCI DSS 3.2); never on the bus/logs/argv/env/disk.

**BUILT:** `services/fiat-cvm/card_capture.ts` — `cardValues()` returns a
`CardHandle` whose `toString()` and `toJSON()` **redact**, whose `use()` destroys
values in a `finally`, and which refuses a second charge (single-use CVV).
`requestCardDetails()` / `requestOtp()` on the client. 7/7 tests, synthetic PANs only.
`tools/fake_merchant.py` — local checkout logging SHAPE only (`pan_len`,
`pan_luhn_valid`, `cvv_len`), never values; verified captured/declined.

**STILL OPEN (R3b):**
1. Drive the fake merchant with Playwright: fetch → fill → submit → OTP loop. $0.
2. **The real merchant is Stripe Elements in cross-origin iframes** (FoodAmigos) —
   materially harder than the fake page, and NOT proven by it. This is the real risk.
3. The step-up direction is inverted vs the fake: the MERCHANT triggers 3DS and
   2fiat surfaces the OTP via `GET .../otp`. Only a real charge settles that.
4. Cards currently hold **$0.38 / $0.18** — a real test needs funding (~€2 is plenty)
   via the now-built `topup` tool + the proven treasury NWC rail.
5. `pay` in `tools.ts` still returns `requires_3ds`; its message now names the
   MEASURED cause instead of blaming 3DS. The state name is retained for the
   console contract.

### R4 — NIP-98: ALREADY DONE, do not re-implement

`src/nip98.ts` verifies kind-27235 events with **real schnorr verification**
(not a pubkey comparison), and enforces: signed by `FACILITATOR_NPUB`,
`payload` = sha256 of a live single-use challenge nonce, fresh `created_at`,
`u`/`method` request-binding, and **replay refusal**. `NIP98_STRICT=1` refuses the
challenge-bound form. Wired into the facilitator routes; **10 passing tests**.
The plan's original premise ("the server must verify the signed event") was
**stale** — a worker following it would have re-implemented an existing security
boundary. Remaining: board leftovers only.

### R5 — clean-clone CI: DONE (`cvm-orders 268c496`, `a21664f`)

A fresh clone with no local state reproduces the suite (212 at the time; 228 with
the spend tests). Found there was **no CI at all**; `.coverage-threshold` enforced
nothing. The workflow asserts the live mint tests **SKIP** (rather than assuming
it) and enforces coverage via lcov with a **fail-closed** guard — my first version
scraped the pretty table, read an empty string, and silently PASSED.

---

## §0b TREASURY (fleet Cashu NWC rail) — MEASURED CONTACT

Design (from the operator's handover): a treasury wallet whose **seed never leaves
T14**; services spend via a **revocable NWC URL** (NIP-47, NIP-04); a broker on
T14 enforces a policy — **payments ≤ 21212 sats auto-approve**, above that or
amountless needs **2-of-2 operator approval**. Mints include `minibits`.

**Architecture decision (operator, 2026-10-16): keep BOTH spend paths.** Own mint
for issuing vouchers; NWC rail for spending. `cvm-orders`' `PaymentRail` and the
kit's `LnWallet` are the same shape, so this is a second implementation, not a
rewrite.

**What has been MEASURED from x280 (2026-10-16):**

- `~/hermes-trust-root`, the admin/approval sockets, and `fleet-age.key` are **NOT
  on this box** — the treasury is T14-local by design. All 7 SSH-reachable hosts
  (`cobrador`, `dq05`, `hermes-nvme`, `testserver2`, `t440`, `x240`, `vps2fips`)
  report `no-trust-root`. T14's mesh address is **unreachable** from x280.
- **NWC works over a relay, not a direct route.** `relay.primal.net:443` is open;
  all three documented relays are reachable.
- `NwcLnWallet` exists at `/data/repos/cvm-service-kit/src/lnwallet.ts`
  (`balanceSats`, `makeInvoice`, `payInvoice`), needs `deno install` for
  `nostr-tools/relay`, and `bun` is at `~/.local/bin/bun`.
- **A real NIP-47 round-trip reached the broker and the broker answered:**
  `NWC error: unknown service pubkey`. That is the broker saying it has not loaded
  the new service — the handover's own `next` field says *"restart the broker to
  load the new service"*. **This is not a network failure.**
- Treasury balance was **4 sats** (cubabitcoin) at handover; nothing can be paid
  until it is funded.

**BLOCKED-ON-OPERATOR (only the operator can do these):**

1. `cd ~/hermes-trust-root && make treasury-restart` — loads the `cvm-orders`
   service key into the broker. Unblocks everything below.
2. `make treasury-fund SATS=<n> SLUG=minibits` — external Lightning payment; the
   treasury is nearly empty.
3. Rotate the NWC secret (`make treasury-addkey NAME=cvm-orders ROTATE=1`) — the
   current one was pasted into a group chat. Capped at 21212 sats, so bounded.

**SECURITY:** the NWC URL is a bearer credential. Store it in OpenBao, never as a
shell literal, never on argv, never in a log. The **seed never leaves T14** — no
node may copy it; `hermes-trust-root` has no remote and its history must never be
pushed.

---

## §2 Definition of done — ALL of it, every task

1. **TDD** — the test exists and was observed FAILING before the implementation.
2. **Tests pass** — the full suite, output verified, not asserted.
3. **Coverage ≥ 80%** on changed files.
4. **Cross-family review PUBLISHED** — post it to the PR. A same-family pass is not a review.
5. **Atomic commits** — one concern each, conventional messages.
6. **Consolidated to the DEFAULT branch** — "pushed a branch" is not done; verify
   with `git ls-remote origin <default>`.
7. **Dual-push** — GitHub **and** ngit, both verified. **Gotcha:** `nostr.nsec` is a
   *local* repo config key; a fresh clone cannot push to ngit until you copy it
   (`git config --local nostr.nsec <from a working clone>`).
8. **LIVE tests for anything touching a protocol.** `CVM_LIVE_MINT_TESTS=1` is
   **mandatory** for any change to mint/melt/ecash shape. The doubles will agree
   with your bug.
9. **Honesty contract** — never claim a commit/push/test/PR you did not observe in
   tool output. If budget runs out, state the step you stopped at and list the
   REMAINING steps. **Blocked with a measured reason is a SUCCESS.** Never
   fabricate output.
10. **PROGRESS.md** at the worktree root, appended per cluster
    (`finding -> status -> files touched`); **REPORT.md** before the final reply.

### Hard constraints

- **ADR-0013:** card VALUES (PAN/CVV) never in an agent context, log, argv, env,
  disk, or clipboard. Only `2fiat-local-adapter` may hold card material, in memory.
  The **session token** is a different asset (vault-resolvable) but still never on
  argv or in a log.
- `2fiat-local-adapter` stays **PRIVATE** (`tests/test_repo_visibility.py`); no
  token/PAN may be committed (`tests/test_no_token_material.py`).
- **2fiat's rate limiter is SHARED across hosts** — one request at a time, never
  burst. A burst previously blocked two machines.
- Only venues with an **online** checkout are supportable; others are refused at
  `priceOrder` (`venue_not_supportable`).
- `order_url` comes from committed venue **RECORDS**, never the flaky relay capture.
- **Never again assert a wall you have not measured.** If you cannot measure it,
  say `unmeasurable` and why.
- Layout: repos in `~/repos/<repo>` (+ `/data/repos` symlinks); **worktrees in
  `~/worktrees/`, never `/tmp`**. Deno 2.9.7 (`export PATH="$HOME/.local/bin:$PATH"`).
- **Quota gate first** on any LLM-driven dispatch; never bypass it.

---

## §3 THE TASKS

### T1 — NWC rail: DONE (verified live)

`balance_sats: 20002` measured from x280 through `relay.primal.net` against the T14
broker, using `cvm-service-kit`'s `NwcLnWallet`. Two real-money facts learned the hard
way, both now encoded in code + tests:

- **A `pay_invoice` timeout is NOT a failure.** The broker executes the payment and
  publishes no reply (measured: `get_balance` replies in 438 ms, `pay_invoice` never).
  Measured balance moved 20002 → 19874 during a "timeout". **Retrying would
  double-pay.** `NwcTimeout.outcomeUnknown` classifies spending methods; recovery is
  `resumeClaim()`, which asks the MINT, never the wallet.
- **Persist the quote BEFORE paying.** The first live attempt lost 128 sats of ecash
  because the mint quote id was not journalled before the payment left.
  `src/treasury_fund.ts` journals atomically (tmp+rename) first, and the test asserts
  the CALL ORDER, not just the end state. Also fixed: **the mint is the authority** —
  after a silent wallet, `fundAndClaim` polls the MINT's settlement state.
  `src/envfile.ts` quotes values, because an unquoted `&` in `NWC_URL=...` silently
  truncates it to empty.

Shipped: `cvm-orders 8f4efa5`, `500e3dc`; `cvm-service-kit 9701f2b`; 249 tests.

**Infra fix landed too:** OpenBao AppRole `fleet-node-x280` now logs in (200) and
`secret/data/fleet/2fiat` is readable — the 2fiat service is no longer one restart
from death. Note the vault field holds a **wallet URL**, not a bare token: the
credential is the `token1…` PATH SEGMENT. Anything treating the field as a token
sends `Bearer https://...` and fails silently.

### T2 — R1c: DONE (the funded refund proof, production mint)

Superseded by fact. See "R1c — DONE" above: real sats, real mint, `MINT VERDICT: PAID`.

### T3 — R3b: prove the capture MECHANISM, then one real charge

**The spend question is answered** (see the R3 section): no charge-by-reference
endpoint; card VALUES required; ADR-0013 amended; `card_capture.ts` +
`fake_merchant.py` built and tested.

Remaining, in this order — do not skip ahead:
1. **$0:** drive `tools/fake_merchant.py` with Playwright using SYNTHETIC values
   (4111…): fetch handle → fill PAN/expiry/CVV → submit → assert `captured`. Then the
   `--step-up` path: read the OTP via `pendingOtp()` and submit it.
2. **Then, and only then, a real charge.** Fund a card (~€2 is plenty) with the
   `topup` tool, paying its BOLT11 from the treasury NWC rail.
3. **The known-hard part, do not under-estimate it:** the real venue checkout is
   **Stripe Elements in cross-origin iframes**, which the fake merchant does NOT
   model. Iframe filling is the actual remaining risk for full automation. Measure
   it; if it resists, the honest verdict is `SPEND: human_required` for the card
   field, and that is a legitimate outcome — not a failure.
4. The real step-up direction is inverted from the fake: the MERCHANT triggers 3DS
   and 2fiat surfaces the OTP. Only a real charge settles whether the OTP loop works.

Exit: `SPEND: unattended | human_required | unmeasurable` with evidence from a REAL
attempt (the $0 work only proves the mechanism, not the verdict).

### T4 — R2: coordinate-based astra attempt, then close it

- **Untried approach:** screenshot → `vision_analyze` (astra) for the exact click
  target → `mouse.click(x, y)`. Act on coordinates, not selectors.
- **Guard that must stay:** abort loudly when the modal is still open, with a
  screenshot — that check's absence is what let a blocked page read as "no
  controls exist" for several turns.
- If coordinates fail too: close R2 as **out of scope** and say plainly that it is
  a convenience gap, not a money path. Do not spend more turns on it.

### T5 — operator-owed items (record, do not attempt to subvert)

- `make treasury-restart` / `make treasury-fund` / NWC secret rotation (T14).
- Org-owner: `merchant-routing` transfer-out and the stale
  `2fiat-local-adapter` description — the acting account is `member` with `push`,
  not `admin`; both calls 404. Record as **blocked-on-operator**, never silently drop.
- Cleanup: stale `role-id.vps-bak` / `secret-id.vps-bak` beside the live AppRole creds.
- Vault: the node's AppRole (`fleet-node-x280`) logs in (200) but reading
  `secret/data/fleet/2fiat` is **403**; fixing needs `sudo` on `sys/policies`,
  which the node deliberately lacks (ADR-0020).

### T6 — board leftovers + fresh-clone re-verify

- Reproduce the suite from a clean clone (now **228** tests) off the author's
  machine; confirm live tests still skip by default.
- Board leftovers from the org-consolidation work.

---

## §4 Progress log (append; never delete)

- R0 — DONE (`2fiat-local-adapter 5bdc6d0`). 3DS claim wrong for details;
  `not_required` for details, spend unproven.
- R1 — **DONE for real** (`cvm-orders f1b51bd` spend leg, `b35f143` spendable
  proofs). Live melt → mint says PAID. Four live-only defects found.
- R1b — DONE (`cvm-orders 1aba105`), quote-level only; could not catch the spend
  defects.
- R1c — **DONE** (`cvm-orders c7d0074`). Production Minibits, real sats,
  `MINT VERDICT: PAID`, NUT-08 change returned. Found that `rail.ts` DISCARDED the
  melt quote's `fee_reserve`, so every melt guessed the fee and was rejected 11005.
  Paid threshold measured: 1 and 4 sats never settle (cost 0), **8 sats works**.
- R2 — modal **SOLVED** by vision-measured COORDINATE clicks ((967,328) then
  (683,1092)) where five selector strategies failed. Remaining: one add-control
  click to capture the `/order-drafts` body.
- R3 — **spend question ANSWERED for $0** (`contextvm-services 431b9aa`, `4d68ebe`):
  no charge-by-reference endpoint (`prepaid-cards/pay` -> 404 product_not_found);
  `details/{id}` returns PAN/CVV; `.../otp` returns the 3DS code as JSON. ADR-0013
  amended (operator decision); `card_capture.ts` + `fake_merchant.py` built, 7/7 tests.
  Verdict: automatable in principle; the Stripe cross-origin iframe is the real risk.
- Treasury — **LIVE**: `balance_sats: 20002` measured from x280. Then, on real money:
  pay_invoice timeouts are UNKNOWN outcomes (never retry); persist the quote BEFORE
  paying (cost 128 sats to learn); the MINT is the authority, not the wallet.
- OpenBao — **FIXED**: AppRole `fleet-node-x280` logs in (200), `secret/data/fleet/
  2fiat` readable. Field holds a wallet URL; the token is its `token1…` path segment.
- x280 networking — 2fiat.com resolves via NAT64 (`64:ff9b::`) and that path HANGS;
  plain IPv4 answers in 0.7s. Every "2fiat is down" conclusion was this.
- Loop record corrected: `cvm-services c5c1341` (and this revision).
- R4 — NIP-98 half already existed; board leftovers only.
- R5 — DONE (`cvm-orders 268c496`, `a21664f`). No CI existed before this.
- Treasury — MEASURED CONTACT: relay OK, broker answered
  `unknown service pubkey` ⇒ needs `make treasury-restart` on T14; treasury at
  4 sats ⇒ needs funding. Both operator-owed.
- Loop record corrected: `cvm-services c5c1341`.
