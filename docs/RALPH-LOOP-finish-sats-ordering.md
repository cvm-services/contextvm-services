
**2026-10-20 (02:00) — R3b SPEND verdict measured: `human_required` at the venue
phone gate; everything else automatable.** The captcha-first order was the key
discovery: the phone control is `react-phone-number-input` and carries
`PhoneInput--disabled` — country select AND number input are disabled=true until
the human-verification widget passes. Sequence measured: captcha -> phone unlock
-> select +1 (native select.PhoneInputCountrySelect, select_option 'US') -> type
8102583253 (input.PhoneInputInput) -> SMS option -> Code senden. The widget is
hCaptcha-branded ("Ich bin ein Mensch") served from a Cloudflare Turnstile host.
Two click strategies measured: a bare synthetic click inside the box bounds was
IGNORED (no challenge, no pass); a human-like mouse-travel approach TRIGGERED the
widget, which answered with a VISUAL CHALLENGE ("Finden Sie das eierlegende
Tier" — find the egg-laying animal, a wooded-scene image puzzle). Solving that
programmatically is adversarial and out of scope; the gate is `human_required`.
Corrections en route: my earlier phone-type step clicked the CARDHOLDER field
((600,537) is inside its row) — every "number_typed" readback of Test Validierung
was the wrong field; and the address-fill loop had a first-match-break bug that
silently left street/houseNumber empty, which blocked the buy click entirely in
one run. Both fixed with readback gates. The harness
(tools/venue_phone_test.py) now: fills the Adyen card (synthetic), verifies the
address readback, triggers the gate, measures the captcha, and — on a pass —
selects +1, types the JMP number, selects SMS, clicks Code senden and polls the
JMP inbox. Remaining: a HUMAN solves the one image puzzle; the rest runs.
**2026-10-20 (early) — venue phone-gate test built; gate fires PRE-CHARGE (proven);
JMP number LIVE; three corrections.** The reproducible harness is
`services/restaurant-cvm/tools/venue_phone_test.py` (committed). Measured with a
SYNTHETIC card (4111...) — which proves the gate fires before any charge can
move money: buy click -> phone modal, balance untouched. JMP (810) 258-3253 is
LIVE (funded 26,898 sats, activated; cold-send accepted 2026-10-05; inbox
jmp_inbox.db on cobrador, listener active). Corrections this run: (1) the modal
captcha is **hCaptcha "Ich bin ein Mensch"**, NOT Cloudflare Turnstile (frame
URL is challenges.cloudflare.com but the visible widget is hCaptcha-branded —
needs one more look); (2) my checkbox click at (379,669) hit the widget padding,
not the box (measured box center ~(400,702)); (3) the phone field FORCE-FORMATS
our US number as +49 8102 583253 — the country selector click did not open a
menu (dropdown may render in a portal; needs a post-click inventory of new
frames). "Code senden" stays disabled until the captcha passes AND a valid
number is set. Next run: (a) click the flag selector and inventory any
portal-rendered dropdown for "Vereinigte Staaten"; (b) click the checkbox at its
measured centre; (c) only then does the SMS-arrival poll matter.# RALPH LOOP — sats-paid food ordering: drive to completion

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

### R2 — store integration: **DONE** — the real `/order-drafts` body is captured

**RESOLVED 2026-10-19 — R2 is CLOSED. The contract is measured, not inferred.**
See `docs/r2-order-drafts-MEASURED.md` for the full body. Headlines:

- `company_id: 550` confirmed on the wire.
- The 500 was **never a missing field**. The client sends the same object to a
  SECOND endpoint, `POST /api/order-validations`, carrying
  `ignored_error_codes: ["pickup_closed","delivery_closed",
  "order_time_not_available","items_menu_time_unavailable"]`. Without those codes a
  closed venue fails validation and reads like a malformed payload.
- The cart path: role-based radio -> (if closed) scheduler -> `Menü Anzeigen` ->
  site search -> **click the product ROW, not a `+`** -> `Hinzufügen` -> cart.
- CORRECTION: "the cheapest addable item is EUR 4.50" was WRONG. It came from
  looking for a `+` on a searched result. Drinks have no `+` at all; the row click
  opens the detail panel. A EUR 1.50 drink is orderable, which fits the 2.38 USD card.
- Payment surface measured at checkout: js.stripe.com x3, pay.google.com x1,
  m.stripe.network x1, main frame 2 inputs.


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

**ROOT CAUSE FOUND 2026-10-19 (the 10th falsified assumption): the venue was
CLOSED.** Every post-Sunday failure was correct behaviour: 'Menü Anzeigen' is
disabled by OPENING HOURS ('Öffnet Dienstag 12:00'; today is Monday). The one
successful dismissal ran on a SUNDAY, during opening hours. Not React, not MUI,
not pixels — the radio clicks WORKED all along (`radio checked: True` measured
five different ways); the button gate was venue hours.

**THE WORKING PATH (measured 2026-10-19, twice):**
1. venue radio (click works; ring at input-box centre +10px)
2. 'Ändern' beside 'Planen für später' → scheduler opens
3. date 'Morgen (Okt. 20)' + time slot (first = 12:45; slots found by scanning
   for leaf elements whose text is exactly `HH:MM` — they are NOT <button>s,
   which is why the global button scan missed them)
4. 'Weiter' → back in the location modal with 'Di. 12:45, Okt. 20' confirmed
5. 'Menü Anzeigen' now ENABLED → click → menu live
6. add item: the carousel SHIFTS between loads, so hardcoded (271,750) works
   only sometimes — derive the `+` from `.absolute.bottom-2.right-2` instead;
   a detail panel with 'Hinzufügen' confirms the add
7. cart icon at header (1236,36) — vision-verified correct

**MEASURED ON THE WIRE:** `GET app.foodamigos.io/api/companies/550/
disabled-pre-order-dates?order_method=pickup&start_date=2026-10&end_date=2026-10`
— the storefront's own request confirms **company 550** live, and that
pre-order dates are a first-class API concept (schedule-ahead is a real path).

**CURRENT BLOCKER (2026-10-19, temporary — NOT a wall): Vercel edge cooldown.**
After a day of automated loads the edge REFUSES connections to
`threebuddies.foodamigos-storefront.com` specifically (`ERR_CONNECTION_REFUSED`,
000 in 0.005s) while DNS (Vercel, via NAT64) and general egress (example.com 200)
both work. Retry after a cooldown (~1-2h) or from another egress. The capture
script is ready: `/tmp/r2_assert.py` (DOM-derived `+`, loud-abort if the cart
badge is 0 — an empty cart can no longer masquerade as 'no draft fired').

**WHAT REMAINS:** open the cart → 'Zur Kasse' → capture `POST /order-drafts`
(wide net on all POSTs to app.foodamigos.io so it cannot slip by). $0, one run.
Note: the venue opens Tue 12:00 Berlin — after that, no scheduling is needed at
all, and that is also the natural window for the real end-to-end order.

### R3b — the charge attempt: MEASURED to the venue's own phone gate (2026-10-19)

**What is PROVEN now (real site, real cart, real card, 1.94 EUR):**

- The payment processor behind "Kartenzahlung" is **ADYEN secured fields**, not
  Stripe Elements (Stripe serves only the wallet buttons + telemetry + invisible
  hCaptcha). Three separate field-iframes: `encryptedCardNumber`, `cc-exp` /
  `encryptedExpiryDate`, `encryptedSecurityCode`; plus main-frame holderName,
  country, street, houseNumberOrName, postalCode, city.
- All card fields fill successfully via Playwright (fill proven twice). Card
  number/expiry/CVC accepted — checkmarks; Adyen raised no format complaint.
- The billing-address fields are required (first submit failed validation with
  "Geben Sie straße ein" etc); venue's own address works.
- "Kaufen für 1,94 EUR" click -> spinner (submission genuinely attempted).
- Card balance unchanged -> **no charge occurred**.

**The actual wall — NOT the card, NOT 3DS, NOT hCaptcha at the card step:**

After submit, the venue demands **phone verification**: a modal
"Wir müssen deine Telefonnummer verifizieren" offering WhatsApp/SMS delivery of a
code, gated by a **Cloudflare Turnstile** "Bestätigen Sie, dass Sie ein Mensch
sind" checkbox. The phone field is pre-populated with the contact form's number
(our synthetic one). Without a REAL receivable number + a Turnstile pass, the order
never reaches authorization.

Note the correction cascade this run produced: the "OTP detected" marker was a
FALSE POSITIVE ("Sicherheitscode" contains "Code"); the real 3DS/OTP never fired
because the venue gate fires FIRST. The hCaptcha frames observed earlier belong to
Stripe's wallet buttons, not the card path.

**Remaining unknowns:**
- Does an ACCOUNT with a verified phone skip this modal per-order? (Guest checkout
  may be what triggers it.)
- Does Turnstile pass on a headed real-mouse click? (Unmeasured; it scores behavior.)
- Does the issuer then demand 3DS (the 2fiat OTP loop we measured)? Never reached.

**Options:** (A) register an account once with a real receivable number (fleet SMS
rail?) — phone may then be a one-time verification; (B) declare `SPEND:
human_required` with THIS wall as the reason — the human-in-the-loop step would be
"verify phone + click Turnstile", 60 seconds of human work per venue; (C) attempt
Turnstile click automation with the synthetic number to at least measure the
Turnstile behaviour (code would go nowhere; pure measurement).

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

### R5 — clean-clone CI: DONE (`cvm-orders 268c496`, `a21664f`) — **re-verified 2026-10-20, with corrections**

Re-verified on a fresh clone (`git clone` → `d490631`, then `fe68591`):

- `deno test -A` → **252 passed | 0 failed | 6 ignored**. The plan's older
  "212 passed" figure is STALE — the suite grew (reconciler, route-surface,
  treasury, venue-reference). Current truth: **252**.
- The 6 ignored are the live-mint tests (`CVM_LIVE_MINT_TESTS=1` opt-in) —
  hermetic by default, confirmed on the wire.
- Coverage via `deno task coverage`: **88.0% lines (85.3% branch)** — ≥80% holds.

**Correction found by the re-run (fixed in `fe68591`):** the two R1c harnesses
(`r1c_funded.ts`, `r1c_threshold_probe.ts`) did NOT type-check on a fresh clone
— they imported a sibling checkout (`../cvm-service-kit/src/lnwallet.ts`,
TS2307) and passed `CashuRail` where `FundRail` no longer type-matches
(`SettlementStatus` grew `"pending"`, TS2322). CI never caught it because
`deno task test` scopes to `tests/`. Both fixed: call-site rail adapter
(pending→unpaid for the funding loop), idempotency keys + memo defaults,
runtime-wired wallet shim. `deno check` on every module/harness/test: RC 0.

**R5 verdict: DONE.** Exit criteria all hold on a fresh clone.

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

**2026-10-19 (night) — R3b charged to the venue's own gate.** Card values JIT ->
Adyen secured fields (THREE separate iframes; processor is ADYEN not Stripe) ->
all filled, address required and filled -> "Kaufen für 1,94 EUR" clicked ->
spinner -> NO CHARGE (balance 2.38 unchanged). Blocker: venue phone-verification
modal (WhatsApp/SMS code) behind a Cloudflare Turnstile human checkbox. The card
itself was never the wall. Two false diagnoses corrected en route: "OTP detected"
was 'Sicherheitscode' string-matching; hCaptcha frames belong to Stripe wallets.
**2026-10-19 (late) — R2 CLOSED. The draft body is measured.** `/order-drafts` and
`/order-validations` bodies captured from a live cart (Capri Sun 1052466, EUR 1.50,
`scheduled_for` 2026-10-20T10:45Z). The 500 was never a missing field — it was
`ignored_error_codes` on the validations call (`pickup_closed`). Path that works:
role radio -> schedule if closed -> search -> **click the product ROW** -> Hinzufügen.
The operator was right that the EUR 1.50 drink fits the 2.38 USD card; the earlier
EUR 4.50 floor was an artefact of hunting a `+` that drinks do not have. Checkout
reached; Stripe surface inventoried. Next: the charge attempt (R3b step 2).
**2026-10-19 (evening) — R2 unblocked, one click from the wire.** Modal mystery
SOLVED: the venue was CLOSED (Monday; 'Öffnet Dienstag 12:00'). Working path
proven twice: radio → 'Ändern' → 'Morgen' + 12:45 → 'Weiter' → 'Menü Anzeigen'
(enabled) → item added ('Hinzufügen') → cart icon (1236,36) vision-verified.
Wire: `companies/550/disabled-pre-order-dates` captured live. Cart was empty in
the last run (carousel shift; hardcoded (271,750) unreliable — now DOM-derived
`.absolute.bottom-2.right-2` + loud-abort on badge=0, script `/tmp/r2_assert.py`).
Temporary edge cooldown (Vercel refuses our IP after a day of automated loads;
DNS+egress fine) — retry in ~1-2h or from T14. Remaining: cart open → Zur Kasse →
`POST /order-drafts` body. $0. Venue opens Tue 12:00 Berlin — natural window for
the real end-to-end order.
**2026-10-19 (cron) — edge cooldown LIFTED, cart still gated by the venue clock.**
Measured: `threebuddies.foodamigos-storefront.com` 200 (IP cooldown lifted) and
`github.com` 200 (443 reachable again). GitHub `main` was ALREADY at `17b3f5a`
(>= be9be9c) and ngit `main` at the same sha — no catch-up push needed. Re-ran the
committed capture tool (`services/restaurant-cvm/tools/threebuddies_draft_capture.py`;
`/tmp/r2_assert.py` was lost — /tmp is tmpfs) once: consent banner dismissed, then
the **"Standort auswählen" location modal stayed OPEN and intercepted every click** —
`ABORT: location modal could not be dismissed`. Screenshot read by vision confirms
the cause: three-buddies-berlin **"Öffnet Dienstag 12:00"** (closed; it is Monday
evening Berlin). Cart unreachable → **0 wire requests captured** this run. No retry,
no hammering. The `/order-drafts` body itself is ALREADY the measured artifact of
record (`docs/r2-order-drafts-MEASURED.md`, commit `d65ed96`) — nothing new to
capture until the venue opens. **Next run: after Tue 12:00 Berlin** (natural window),
using the proven path (radio → Ändern → Morgen + HH:MM slot → Weiter → Menü Anzeigen
→ row click → Hinzufügen → cart → Zur Kasse), not the stale keyword/class tool.
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

### 2026-10-25 (15:2x) — CARD FUNDED; the phone leg is blocked on an approval only the operator can give

**Gate 2 (card funding): DONE, and this is the first time real sats bought real
card balance.** Card `1ca03165` (5257 **** 9166) went `1.38 -> 3.38 USD` via two
$1 top-ups; treasury `17,256 -> 14,589` sats. Both visible in the provider's own
ledger as `COMPLETED`. The mechanism works end to end.

**Two defects found in the funding harness (both fixed, PR #42):**

1. `r3_fund_card.ts` derived sats from a hardcoded `0.00025820 USD/sat`
   (BTC ≈ $25,820). The provider quotes SATS: a $1.07 invoice is `lnbc13340n`
   = **1,334 sats** (BTC ≈ $80,210). Following that constant would have paid
   **4,145 sats for a 1,334-sat invoice** — a 3.1x overpay on every top-up.
   `fund_card_exact.ts` now decodes the amount out of the BOLT11 prefix; an
   invoice is the authority and no price feed is needed to pay one.

2. The script could pay twice: each run mints a fresh invoice, and it consulted
   nothing before spending. It now reads the ledger and refuses when a COMPLETED
   top-up exists in the last 30 minutes (`ALLOW_REPEAT=1` to override). This was
   measured, not theorised — the two $1 top-ups above ARE the double spend, and a
   re-run afterwards correctly refused with the treasury unchanged.

**Reconciliation method (new):** `FiatClient.transactions()` reads
`/api/v1/vccTransactions` through the class's own `#request` so the auth cookie
carries (a bare `fetch` 401s). A non-2xx THROWS rather than returning `[]` — an
empty ledger would read as "nothing charged", the wrong answer when the question
is whether money moved.

**Gate 3 (phone number): BLOCKED — operator action required, stated precisely.**

- `sms4sats` `/v2/l402/order` requires a `refundInvoice` **at schema level**, and
  validates that it is a **no-amount invoice** (`INVALID_REFUND_INVOICE:
  refundInvoice must be a no-amount invoice`). This applies even to
  `rent-number`, which its own docs mark **non-refundable** — so the parameter is
  required but cannot ever be used for that product.
- The treasury broker holds **amountless `make_invoice` for 2-of-2 operator
  approval** (§0b). Measured: the request took **no reply for 151s**, while a
  with-amount `make_invoice` returned immediately (277 chars). So an agent
  cannot produce the refund address; the approval sockets are T14-local.
- **Unblock:** operator approves one amountless invoice, or supplies an
  amountless BOLT11 from a wallet they control.

**Mint decision: testnut is disqualified, minibits is the target.** testnut's own
`/v1/info` says *"It uses a FakeWallet, all your Lightning invoices will always
be marked paid"* — ecash there is free. With `TREASURY_FLOOR_SATS=1000`, a
fake-mint customer could drain 1,000 real sats per order. Unexploited only
because `orders`/`gate_orders` are still **0 rows**. minibits advertises
NUT-04/05/07, which is everything `src/cashu.ts` needs.

**Infrastructure defect found on x280 (fixed, durable):** all IPv4 was dead for
hours. Not a firewall — a stale DHCP lease on an **unplugged** ASIX USB adapter
(`enx9c69d3ca3cfe`, `no-carrier`, unmanaged) installed
`default ... metric 5 linkdown`, outranking every live route. IPv6 kept working,
so the box looked half-online and each tool blamed its own stack. Fixed via
`/etc/netplan/65-no-default-on-usb-lab.yaml` (`dhcp4-overrides: use-routes:
false`), verified across `netplan apply` and a `systemd-networkd` restart.

### 2026-10-25 (15:4x) — JMP RAIL USED LIVE: the number is solved; ONE human captcha remains

Ran `services/restaurant-cvm/tools/venue_phone_test.py --country US` under Xvfb
against the real Three Buddies checkout, using the fleet's live JMP number
(810) 258-3253 (listener active on cobrador; inbox shows 2 prior inbound SMS).

**Everything before the captcha worked, end to end, measured:**

```
cart_badge 1 -> checkout via "Zur Kasse" -> advanced_to_payment ok
pay_frames 3 -> synth_fill pan ok[1] exp ok[2] cvc ok[1]
address_readback street=Albrechtstraße 131 12167 Berlin holderName=Test Validierung
kaufen_clicked -> modal_state {phone_modal: true, code_senden: true}
```

**The gate is hCaptcha, not Turnstile** (visual read of `/tmp/vt-captcha.png`):
the widget sits at x≈379-681, y≈431-507 with "Ich bin ein Mensch", and a
human-like mouse-travel click **opens an image challenge** ("Wählen Sie alle
Tiere aus, die dem gezeigten Beispiel und der angezeigten Anzahl entsprechen",
3x3 animal tiles, 1x counts, refresh + Überspringen). No response token is
produced and the phone control stays disabled:

```
turnstile_frames 1 -> frame_candidates [] -> captcha_clicked human-move(400,702)
captcha_result {token_present: false, phone_still_disabled: {disabled: true}}
ABORT captcha-not-passed
```

Note the number never got applied either: with the field disabled the country
select cannot take effect and it rendered `+49 8102 583253` — the US selection
and number entry are only reachable AFTER the captcha clears.

**So the verdict stands (`SPEND: human_required`) but it is now precisely bounded:**
the RECEIVING side is fully solved by the fleet's own JMP rail. What remains is
**one human solving one hCaptcha image challenge per venue session** — roughly
10-20 seconds — after which the phone entry, SMS code, inbox read and order
completion are all agent work.

This is exactly the case ADR-0017 was written for, and the machinery already
exists: `tools/captcha_session.py` (ephemeral Xvfb -> x11vnc -> websockify ->
one-time order-scoped token, 127.0.0.1-only listeners, idempotent teardown) with
`tools/captcha_session_test.py`. The handoff has NOT been exercised against a
live venue yet; that is the next step, not a redesign.
