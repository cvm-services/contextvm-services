# PLAN-0008 — Account creation and login on a venue-owned rail (Class 2, pizza-e-pasta only)

- **Status:** plan for review, 2026-10-10. Implementation is gated on this plan's cold review.
- Plan review: the cold review is in `docs/reviews/PLAN-0008-cold-review.md` and its verdict is
  APPROVE-WITH-CHANGES (reviewer family deepseek, i.e. not the author lane; the router-served model
  id is recorded in that file). Its blocking
  findings B1–B6 are resolved in §9 (R1) below, which supersedes the earlier wording of D2, D4, D5,
  D6, D7 and D9 wherever they conflict.
- **Card:** `t_5b352cfb` — "Venue CVM: account creation + login on a venue-owned rail (Class 2, plan first)".
- **Urgency:** NOW (manager escalation CG-11; the SOON deadline had passed undelivered).
- **Depends on:** ADR-0009 (this capability, decided, design deliberately open), ADR-0007 (adapter classes;
  Class 2 = per-venue opt-in browser automation of a venue-owned rail), ADR-0008 (sats final before fiat),
  ADR-0012 (failure escalates over Nostr DM to the operator), ADR-0013 (fiat leg + "card data stays on the
  facilitator's device" — the same custody shape this plan reuses for a shop password).
- **Tier:** docs/light + implementation.

## 1. What is already true (checked, not assumed)

| Fact | Where it was checked |
|---|---|
| The venue CVM exposes exactly two tools, `menu` and `order`; `order` returns a hand-off payload (basket + the venue's own rail + deep link) and places nothing | `services/restaurant-cvm/server.ts` (877 lines, `TOOL_DEFS`) |
| There is no session handling, no cookie handling, no account store, no auth code of any kind | the same file, read end to end (DATA TYPES, MENU LOADING, TOOL_DEFS, tool bodies) |
| Ordering at this venue requires an account: the venue's own page shows an `Anmeldung` entry point | `venues/pizza-e-pasta-ruedesheimerplatz/evidence/rendered-ordering-page.txt:3`; recon capture |
| The rail is **OrderYoyo** (`/oyy-api`), behind a Cloudflare managed challenge, and the shop is a
  Next.js app whose JSON is server-rendered | `venues/pizza-e-pasta-ruedesheimerplatz/README.md`, `evidence/PROVENANCE.md` |
| A consumer-account rail means the flow requires identity fields the current announcement does not declare | `docs/spec/service-inputs.md` rule 1 ("declare what the flow collects") |
| The org repos — including `contextvm-services` — are **public** | `docs/INDEX.md` (visibility column) |

The recon of the login route itself (form field names, the auth endpoint, where the session lives) is
recorded separately in §8 and in `venues/pizza-e-pasta-ruedesheimerplatz/evidence/auth-recon.json`.

Of that list, one precedent deserves its own line rather than a table row: a **private, local, non-service**
adapter already exists in this platform, deliberately outside the org, whose invariants state that card
values never reach argv, env, disk, logs or the clipboard, and whose CVM may only ever learn a boolean and
a balance — `2fiat-local-adapter/docs/SCOPE.md` §1–§4 (named by ADR-0013). §2 D1 of this plan reuses that
custody shape for a shop session. Two of the §2 options are also laid out as prose there rather than in the
table, for the same reason.


## 2. Decisions this plan takes (ADR-0009 deliberately left them open)

### D1 — The credential lives in a **separate private local adapter**, never in the CVM

`contextvm-services` is public. A file that can log into a real consumer account must not be one mistaken
`git remote` or one leak-scan miss away from world-readable history. Therefore:

- The component that touches account material is a **local, non-service program** on the operator's own
  machine — no inbound listener, no Nostr identity, no announcement, nothing discoverable. This is
  exactly the `2fiat-local-adapter` shape (ADR-0013), applied to a shop session instead of card data.
- **Where the code lives:** a separate **private** repo outside the `cvm-services` org
  (`venue-account-local-adapter`), for the same reason the 2fiat card adapter is outside it.
- **What lands in this public repo:** this plan, the venue's written risk/custody record, the CVM-side
  *interface* (a stub + types + tests that assert no secret can cross it), and the recon evidence —
  never a credential, never a session cookie, never a password.

### D2 — The CVM never learns credential material, and never announces that it needs it

Hard rules from the card, made mechanical:

1. **No `cvm:req:` field for a password** and no credential in the announcement content. The announcement
   may state the *custody* fact in prose (who holds the account, that it is a consumer account) but the
   register stays the vocabulary for user-supplied data only — a password is not user-supplied, it is
   adapter-held. The current venue announcement already declares `cvm:req:ship.address` /
   `cvm:req:contact.phone`; **this plan adds no register field at all**.
2. **No tool response to a non-owner caller may contain credential material.** Enforced by shape, not by
   discipline: the CVM-side account surface returns closed sets of booleans/enums/ids
   (`session_state`, `account_ref`, `observed_at`) and there is a test that calls every tool as a
   non-owner caller and fails if any key or value matches a credential pattern (§7 T5).
3. **No credential in any durable artifact:** no `cvm:req:`, no evidence file, no report, no Nostr DM
   (ADR-0012 already says "never card material"; this plan extends it: never a session token or password).

### D3 — Session handling on the venue rail: a *browser profile*, not a re-implemented cookie jar

The rail's session is a Cloudflare clearance plus whatever the shop sets after login. Two shapes were
possible:

**(a) Extract the session value and replay it from a plain HTTP client — rejected.** Measured: this
origin's clearance is bound to the browser's TLS/JA3 fingerprint and is not transplantable
(`evidence/PROVENANCE.md`, 2026-10-05). A replay client would work until it silently didn't.

**(b) Keep one persistent browser profile owned by the local adapter, log in once inside it, and drive
the venue's own pages from it — chosen.** It is the only shape the origin actually accepts, it is what
the existing menu capture already validates (`capture-menu-requests.py`, persistent profile under
`state/`, mode 0700), and it keeps the account material inside one directory whose mode we control.

Consequences: the session is a **directory** (profile), the secret is a **file** (0600) the adapter reads
to log in, and "is the session alive?" is answered by observing the site, not by reading a clock.

### D4 — Detecting an expired session / when to re-login

Two layers, because "cookie present" is not "session valid":

1. **Cheap preflight (before any order touches the rail).** Navigate to an authenticated venue route
   (the account/profile page) and require a *positive* signal: HTTP 200 **and** the page does not render
   the `Anmeldung` entry point **and** an authenticated XHR (`/oyy-api/.../profile` or the account route
   the recon names) answers 200. Absence of a redirect is not enough; a 200 login page is the classic
   false positive.
2. **In-flow detection (during submit).** Any of: a redirect to the login route, 401/403 on an
   authenticated XHR, or a body containing the login form where an account view was expected — marks the
   session **stale** at the moment it matters.

**Re-login policy (bounded, never silent):**

- stale + credential held → **one** re-authentication attempt, then re-run the preflight. Never a retry
  loop: the rail punishes repetition (the clearance cooldown is the measured precedent).
- stale + credential rejected → transition to `blocked` (§ D5), not to `expired`.
- Both outcomes are recorded in the order's durable state with `observed_at`, so a stale session is a
  fact someone can see, not a silent interval.

### D5 — Banned / account lost mid-order

A ban is not an error to retry. It is a **terminal** state with a named operator action:

| Step | Behaviour |
|---|---|
| Detect | login refused **while the stored login is known to be valid**, an explicit blocked/deactivated message, a 403 on order submit that is not a challenge, or the account page missing the account |
| Do | **stop immediately**; no second account, no change of login, no retry, no bypass attempt |
| Record | order state → `account_blocked` with the venue's own message (ids and status only, no account material) |
| Escalate | Nostr DM to the **operator** (the identity ADR-0012 already establishes) with intent id, order hash, sats proof reference, rail, amount, sats-final yes/no, and what exactly failed — **never** account material of any kind |
| Customer | the same escalation's customer-side thread (ADR-0012 §3): "no charge" / "refund pending" per ADR-0008 |
| Money | sats-final + fiat-not-done ⇒ the ADR-0012 run-1 loss path (capped, notified); a duplicate order is prevented by the existing idempotency key, not by a second account |

**Why "never create a second account" is a rule and not a preference:** a second account is exactly the
behaviour that converts a ban into a platform-level abuse signal, and it is the thing that makes the
custody story a lie. One venue, one account, owned by the operator, said out loud in the venue record.

### D6 — Credential shape, generation, and custody

- **Email:** an operator-controlled alias on a mailbox the operator already owns (never a disposable
  domain — the platform validates addresses; `nomail.name`/`cashu.email` are on disposable blocklists).
  Recorded in the venue record as *which* alias, never with the mailbox password.
- **Password:** generated by the adapter at create-account time (≥ 24 random chars, unique per venue),
  written **once** to the local secret store (0600, outside every repo), read into process memory only.
  **Never** in argv, env, logs, stdout, the clipboard, or an LLM context — the 2fiat §4 invariants apply
  verbatim.
- **Session:** the browser profile directory, mode 0700, under the adapter's own state dir.
- **The CVM side holds nothing** — not a token, not a cookie, not a password hash, not the alias.

### D7 — Per-venue opt-in, declared in `venue.json`, and honest about what it adds

Onboarding stays declarative (ADR-0007 consequence: "onboarding a venue touches zero code files").
`venue.json` gains an `account` block, **only** for the venue that opts in:

```jsonc
"account": {
  "adapter_class": 2,              // ADR-0007: browser automation of a venue-owned rail
  "enabled": true,
  "required_for": ["delivery"],    // the flow that is actually blocked without it
  "custody": "operator-local",     // D1/D6: the private local adapter holds it, nothing else does
  "credential_owner": "<operator npub — the identity that owns the account and the escalation>",
  "recorded_at": "<date>",
  "risk_note": "Automates a CONSUMER account on a venue-owned rail. This can violate the shop's terms and the account can be banned; ... "
}
```

The `doppelt-kaese-berlin` record is untouched — that is the per-venue opt-in proof.

### D8 — The written record (ADR-0009 §4 requires it, in writing)

Three places, one text each, no drift:

1. `venue.json` → `account.risk_note` (machine-readable, travels with the record).
2. `venues/pizza-e-pasta-ruedesheimerplatz/README.md` → an "Account automation — risk and custody"
   section: it automates a **consumer** account, who holds the credential (**the operator**, on the
   operator's machine), where it lives (local secret store + local browser profile, both outside every
   public repo), what happens on ban (D5), and how to revoke (delete the profile + the secret; the CVM
   keeps working as Class 1 deep-link).
3. `venues/.../evidence/auth-recon.json` → the recon that the section is based on.

### D9 — Interface (the CVM-side stub that lands in this public repo)

```ts
/** What the CVM may learn. Nothing here can be a secret. */
export interface AccountStatus {
  state: "unknown" | "valid" | "expired" | "blocked" | "absent";
  venue_slug: string;
  observed_at: string;          // ISO 8601, from the adapter, not from the CVM
  method: "probe" | "in_flow";   // how the state was learned (D4's two layers)
  detail: string | null;         // the venue's own message, redacted
}
export interface VenueAccountAdapter {
  slug: string;
  custody: "operator-local";     // only value v1 accepts
  capabilities(): { can_create: boolean; can_login: boolean; needs_human_step: boolean };
  status(): Promise<AccountStatus>;
  ensureSession(): Promise<AccountStatus>;   // preflight + at most one re-login (D4)
  create(): Promise<{ state: "created" | "exists" | "human_required" | "failed"; account_ref: string | null }>;
}
```

**Transport to the local adapter:** a **loopback-only Unix socket** owned by the operator (0600), never a
network listener, never via Nostr. The TCP/HTTP shape is rejected: a network listener is discoverable and
a shared box makes it reachable. The CVM calls it only for an order that has opted in, and only for a
caller whose presence the order state already authorises.

**Owner gate:** the account-state surface follows the `cvm-2fiat` precedent — `assertOwner(caller,
OWNER_NPUB_HEX)` in `services/cvm-2fiat/src/tools.ts` (ADR-0012 §"the operator identity already
exists"). A non-owner caller gets, at most, `{state:"unknown", detail:null}`; it can never see the
account exists, and can never cause a login.

### D10 — What is explicitly out of scope

- No CAPTCHA/OTP solving and no anti-bot evasion beyond running a real browser (ADR-0007's own boundary).
- No account creation for any venue other than `pizza-e-pasta-ruedesheimerplatz`.
- No automatic card/3DS entry — that is ADR-0013 (2fiat), a separate component with its own gate.
- No wallet, no key, no custody in the customer PWA (ADR-0006 stands).
- No "retry until it works": every loop here is bounded to one attempt per state transition.

## 3. Risk register

| Risk | Likelihood | Blast radius | Mitigation | Residual |
|---|---|---|---|---|
| Account banned by the platform | medium | one order + one account; the venue keeps working as Class 1 | one account, no evasion, no second account, D5 escalation | accepted, recorded in the venue record |
| Account material leaks (login + alias) | low | the consumer account **and** the email alias | private repo, local-only custody, 0600 secret file + 0700 profile dir, argv/env/log ban, nothing of the kind in any tool response, T3/T6 tests | accepted |
| Session silently stale → order dies at checkout | high | one order, user-visible | D4 two-layer detection + bounded one-shot re-login | accepted |
| Duplicate order from a retry | medium | money (ADR-0012 loss path) | existing idempotency key; no retry loops; escalate on ambiguity | accepted |
| Browser drift (DOM/route rename) | high over months | the capability, not the CVM | the adapter is Class 2 and per-venue opt-in; failure is `failed`, never a silent degrade (ADR-0007) | accepted |
| Cloudflare cooldown makes a fresh login impossible for a window | measured, high | capability unavailable for hours | reuse the persistent profile (the existing capture's finding); report, never hammer | accepted |

## 4. Acceptance criteria (mirroring the card's EVIDENCE)

| # | Criterion | Observable evidence |
|---|---|---|
| A1 | Plan exists and has a cold cross-family review | `docs/plans/PLAN-0008-...md` + the review's verdict file |
| A2 | Real account created on the venue's own rail | the venue's own confirmation (its order/account page), captured with the secret redacted |
| A3 | Real login observed on the venue's own rail, and a session that survives a second visit | same, plus a preflight status with `observed_at` |
| A4 | Non-owner caller cannot obtain account material | an automated test that calls every account surface as a non-owner and fails on any secret-shaped key or value |
| A5 | The venue's record states the ToS/ban risk and who holds the account, in writing | `venue.json.account.*` + the README section |
| A6 | Per-venue opt-in proven | `doppelt-kaese-berlin/venue.json` diff is empty; its announcement tags unchanged |
| A7 | No `cvm:req:` field and no account material enters an announcement | a test asserting the emitted tag set is unchanged for both venues |

## 5. Build order

1. This plan + its cold review (this card's first deliverable).
2. Recon of the auth flow (in flight; §8) — names the login route, the form fields, the auth endpoint.
3. Venue record: `account` block + README risk/custody section + updated announcement test.
4. CVM-side stub + types + non-owner test (T5) — lands in this public repo.
5. Local adapter (private repo, outside the org): secret store, profile, `status`/`ensureSession`/
   `create`/, loopback Unix socket.
6. Live proof: create a real account, log in for real, capture the rail's own confirmation redacted (A2,
   A3), then read the session back on a second visit.

## 6. Open questions the review should attack

1. Is `custody: "operator-local"` sufficient, or does the operator want the account under a dedicated
   npub separate from the ADR-0012 escalation identity?
2. Should the CVM *ever* be able to trigger `create()` without an explicit operator action, or is
   create-account strictly an operator-run command on the local adapter?
3. Is "one re-login attempt per state transition" the right bound, or should a re-login require an
   explicit operator approval each time?
4. Is a Unix socket the right transport, or is argv-once (a CLI the operator runs) the smaller surface?
5. Does `required_for: ["delivery"]` hold — i.e. is pickup genuinely account-free at this venue? (The
   venue's page presents `Anmeldung` before ordering; the recon must say whether it blocks pickup too.)

## 7. Test plan

| # | Test | Fails when |
|---|---|---|
| T1 | `venue.json.account` absent ⇒ Class 1 behaviour unchanged (both venues) | any non-opted venue gains account behaviour |
| T2 | Opted venue's announcement tag set is byte-identical to before (no `cvm:req:` addition) | an identity field leaks into the register or into the announcement |
| T3 | Non-owner caller: every account surface returns no secret-shaped key or value | a token, alias or login value reaches a non-owner response |
| T4 | Owner caller with an unreachable local adapter ⇒ `state:"unknown"`, never a fabricated `valid` | a fail-closed path fabricates a session state |
| T5 | Stale-session transition is terminal and named (`expired` → one re-login → `blocked` if refused) | a retry loop or a silent degrade |
| T6 | Redaction: a response builder given a string containing a session value returns it redacted | a redaction function misses a field |

## 8. Recon (what the browser session must answer, and where the answer is recorded)

`venues/pizza-e-pasta-ruedesheimerplatz/evidence/recon-auth-flow.py` drives **one** headed session on the
existing persistent profile and records, redacted:

- the login route the UI advertises (from the `Anmeldung` entry point's own `href`), not a guessed one;
- the login form's field names/types/autocomplete hints, and the button labels;
- every XHR/fetch the shop itself makes on that route (names + statuses only) — this names the auth
  endpoint and the session-bearing response;
- storage key **names** only (never values).

Answer goes to `evidence/auth-recon.json`; §2's D3/D4/D5 and §6's question 5 are then restated against
it in the review.

**No-value-logging constraint (review finding N8):** this script lives in the public repo and drives an
authenticated profile, so it is bound by D2 by construction: it records field names, routes, statuses and
storage key **names**, never a value, and it must never read or write a value-bearing path. Any change to
it that could log a value is a defect, not a preference.

## 9. R1 — resolutions of the cold review (this section wins over §2 where they conflict)

The review returned `APPROVE-WITH-CHANGES` with six blocking findings. Each is accepted; the plan text
above stands as the reasoning, and the following is the binding wording.

| # | Finding | Resolution (binding) |
|---|---|---|
| **R1.1** | **B1** — a non-owner caller could *trigger* account activity via the public `order` tool, though D2.2/D9 only promised it could not *read* material (T3 checks response shape, not side effects). | `assertOwner` is enforced **at the trigger**, not only at the read: `ensureSession()` and `create()` are called only after an owner check, and a non-owner `order` call must never open the local socket. New test **T7** (below) asserts exactly that, by asserting the socket was never connected. D9 is amended: “a non-owner caller can neither see the account nor cause a login attempt.” |
| **R1.2** | **B2** — as written, an anti-bot refusal is indistinguishable from a rejected sign-in, so a Cloudflare cooldown would fire the D5 ban path and the ADR-0012 loss path. | `blocked` requires a **positive ban signal**: an explicit deactivated/blocked message, or the account view missing the account **while authenticated**. Everything else — a challenge, a 403 on submit, a timeout, a 5xx — is the new terminal-for-this-attempt state **`challenge_blocked`**, which does **not** escalate the loss path and does **not** change the stored account state. D5's “login refused while the stored login is known valid” line is deleted; a login refused under a challenge is `challenge_blocked`. |
| **R1.3** | **B3** — an ambiguous submit (response lost) could pay the loss path *and* let the venue fulfil, because the idempotency key only guards retries and the plan forbids retries. | A **reconciliation step precedes any loss declaration**: on an ambiguous submit, query the venue for an order bearing this order's idempotency key (its own order history / the rail's confirm endpoint). Fulfilled ⇒ report `placed` and complete the settlement path; not found ⇒ then, and only then, the ADR-0012 loss path. The idempotency key's existence on the rail is now **verified during recon (A2/A3's session)**, not assumed. |
| **R1.4** | **B4** — A2/A3 may be unachievable behind the challenge, with no contingency. | A2/A3 are **explicitly deferred, not claimed**. Measured condition recorded in `evidence/auth-recon.json` (three navigations, 403 `Nur einen Moment…`, ~180 s each). Two-part contingency: (a) if a challenge needs a human, `capabilities().needs_human_step` is true and the human step is an operator action outside the CVM — recorded, never automated; (b) acceptable interim evidence is the timestamped attempt log plus the recon file, with A2/A3 named as **outstanding, owner = operator**, and the card not marked done on their behalf. |
| **R1.5** | **B5** — per-venue opt-in was asserted; T1/T2 do not show the CVM gates the flow. | The gate is named and tested: `server.ts` reads `venue.account.enabled` per venue, and the account path is unreachable for any venue without it. New tests **T8** (a venue whose `account` block is absent/disabled cannot trigger the account path — asserted by the socket never opening) and **T9** (a venue with `enabled: false` is refused even if an adapter exists for its slug). The other venue's file being untouched is a *fact*, not the proof. |
| **R1.6** | **B6** — D6 recorded the email alias in the public venue record while D2.3 forbids account material in durable artifacts. | The alias is **not** recorded — not in `venue.json`, not in the README, not in any evidence file. Only an opaque, randomly-generated `account_ref` appears (see R2.1). D6's “recorded in the venue record as which alias” is deleted; D8.2 documents custody without naming the identifier. |

Non-blocking findings, all accepted:

| # | Finding | Change |
|---|---|---|
| **R2.1** | **N1** — `account_ref` was an underspecified handle that could be derived from the account. | `account_ref` is defined as a **random per-install id** (opaque; carries no alias, no venue-derived substring, no sequence). |
| **R2.2** | **N2** — “secret-shaped” is undefined; a pattern grep proves absence of *known* patterns only. | T3 gains a **positive control**: with a known sentinel value deliberately placed where a leak would appear, the same test must FAIL — proving the test can detect a leak at all, not merely that it found none. |
| **R2.3** | **N3** — T6 tests the redactor, not the call sites. | New test **T10**: the session value is never passed to any response builder (asserted at the call boundary, not inside the redactor). |
| **R2.4** | **N4** — no transition for “re-login succeeded but the preflight is still stale.” | Defined: it transitions to **`blocked`** (the login is known valid and the authenticated view is still absent — that *is* the positive ban signal from R1.2), and it escalates once, with no second attempt. |
| **R2.5** | **N5** — the single re-login attempt had no cooldown wait, so it could extend a cooldown. | A **minimum wait** before any re-login, derived from the measured challenge behaviour (the recon's per-navigation cost, ~180 s of waiting), and the attempt is skipped entirely if the state is `challenge_blocked`. |
| **R2.6** | **N6** — “ordering requires an account” was inferred from an `Anmeldung` entry point. | Open question 5 is now a **gate on `required_for`**: until recon says whether pickup is blocked too, `required_for` must not be asserted as `["delivery"]`. The venue record ships with the value recon produces, or with the field absent and a note. |
| **R2.7** | **N7** — the ownership field in the venue record could reach the announcement. | Confirmed a real path: the announcement builder maps the venue record into its input. The account block is **not** consumed by that mapping, and **T2** stays a byte comparison as the guard. The ownership field is a reference, never a key. |
| **R2.8** | **N8** — the recon script could log values. | §8 now carries the no-value-logging constraint. |
| **R2.9** | **N9** — no revocation path on the venue side. | D8.2's revoke step is extended: delete the local profile + secret, **and** record that the venue-side account still exists (so revocation of the local custody is not mistaken for deletion of the account); deletion on the venue side, if wanted, is a named operator action. |

Amended tests, as the final set: **T1–T6 as above**, plus

| # | Test | Fails when |
|---|---|---|
| T7 | a non-owner `order` call never opens the local socket | a non-owner call can cause a login attempt |
| T8 | a venue with no `account` block cannot reach the account path | the gate is not enforced in `server.ts` |
| T9 | a venue with `account.enabled = false` is refused even if an adapter exists for its slug | opt-out by config is not honoured |
| T10 | the session value is never passed to a response builder | a call site hands a session value to a builder |

### A2/A3 status (honest)

A1 (plan + review) is **done**. A2/A3 remain **outstanding** and are not claimed: the rail refused every
headed navigation on this host this week (measured, `evidence/auth-recon.json`). They stay with the
operator, with the recon record as the interim evidence.

