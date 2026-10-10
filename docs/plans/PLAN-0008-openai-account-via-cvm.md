# PLAN-0008 — A throwaway OpenAI account, provisioned via ContextVM, funded by a 2fiat Flare card

- **Status:** **DEFERRED — operator-scheduled** 2026-10-10. Operator: *"lets do this test
  at a later point in time with a new openai account that we spin up via contextvm."*
  Work is **parked, not cancelled**. The purpose of this file is that a future LLM session
  can pick it up without re-deriving anything.
- **Date:** 2026-10-10
- **Urgency:** **DEFER** — no money is lost while it waits; nothing is on fire. The whole
  point is to avoid spending a real account on a test.
- **Depends on:** ADR-0013 (fiat leg = 2fiat card CVM + device-only card custody),
  ADR-0008 (real-sats/fiat gate). Earlier context: the OpenAI/2fiat gap analysis,
  `~/reports/reviews/ho-479-xfamily.md` and the gap document under PR #479.
- **Deliverable:** a working assisted-creation rail — a ContextVM service that walks a
  **new, throwaway OpenAI account** from "nothing" to "funded and able to be billed",
  plus the one live charge that settles the open question.

## The open question this exists to answer

> **Can a 2fiat-funded virtual card pay an OpenAI bill?**

This was answered **"no, universally"** and that answer is **WRONG**. It was corrected on
2026-10-10 by reading 2fiat's own public catalogue at
`https://2fiat.com/api/v1/prepaid-cards` (6 products):

| Card | Price | KYC | OpenAI / ChatGPT wording in the vendor's own copy |
|---|---|---|---|
| **Wave** | $50 | no | **EXCLUDED** (listed under "Not supported") |
| **Flare** | $45 | no | **SUPPORTED** — appears under "Use cases:" as *"ChatGPT subscriptions and OpenAI API billing"* |
| Regular | $30 | no | silent — neither supported nor excluded |
| Wavio | $30 | **yes** | silent |
| Flex / Gaming | $30 | — | not on sale |

**The exclusion is product-specific, not vendor-wide.** Flare's own copy names the exact use
case Wave forbids. A 2fiat-funded OpenAI path is therefore **viable, not moot** — and the
cheapest way to find out is one live charge on Flare.

**Silent ≠ permitted.** Only Flare is cleared, and only by its own wording. Never generalise
from Flare to another card.

### Operational trap found the same day — do not re-lose this

2fiat **rejects `curl`'s default User-Agent** at the TLS layer: the handshake completes, then
the server resets the connection (curl reports HTTP `000`). A browser User-Agent gets
**HTTP 200**. Any older note claiming "2fiat is blocked/down" must be **re-tested with a
browser UA** before being believed.

## Why a NEW account — and not the operator's

Two independent reasons, and both are load-bearing:

1. **Ban isolation.** The posture the operator accepted (2026-10-10) is *internal use only,
   ToS risk accepted*. That risk is only acceptable if it is contained in a **disposable**
   account. Spending the operator's real account would convert an accepted, reversible risk
   into an unaccepted, irreversible one.
2. **Clean falsification.** A brand-new account has no payment history, so the first charge's
   outcome is unambiguous. On a used account you cannot tell "Flare is unsupported" from
   "OpenAI locked this account for an unrelated reason".

Corollary: **nothing in this rail may touch the operator's existing credentials.** The
service must never read, copy, or reference the operator's live OpenAI key.

## Goal

A **working assisted-creation rail**: operator-in-the-loop at the steps only a human can pass
(captcha, phone/OTP), automated everywhere else — ending in a running service that can create
a throwaway OpenAI account and drive the Flare card to the point of a single live charge.

## Decisions taken

| # | Decision | Taken |
|---|---|---|
| D1 | The account is **throwaway** and its ban is an accepted outcome | ✅ 2026-10-10 |
| D2 | Provisioning runs as **a ContextVM service**, not a shell script | ✅ operator directive |
| D3 | Card to test: **2fiat Flare only** (the only card whose copy supports OpenAI) | ✅ evidence above |
| D4 | **One** live charge, smallest available amount, then stop | ✅ |
| D5 | Credentials **never** enter CVM output, chat, git, or logs | ✅ standing rule |
| D6 | Test is **deferred**, not scheduled — operator triggers it | ✅ 2026-10-10 |

## Design — the CVM service

New service directory: services/openai-account-cvm/ .

It exposes three MCP tools over the ContextVM protocol, mirroring the shape of
`services/restaurant-cvm/server.ts`:

| Tool | Purpose |
|---|---|
| `account_plan` | Pure. Returns the provisioning plan and the current lifecycle state. No side effects. Lets the operator review before anything is created. |
| `account_advance` | Advances the lifecycle by one step. Refuses to jump states. Returns the next human-action prompt when a step needs the operator (captcha/OTP). |
| `account_status` | Lifecycle state + which rail step is blocking. |

**The lifecycle is a pure state machine** (`lifecycle.ts`) so it is fully testable with no
network, no account, and no card. Side effects live behind a rail interface (`rail.ts`):

```
requested -> email_verified -> payment_pending -> funded -> charge_verified -> active
                                                                          \-> abandoned
```

**Deliberate omissions from v1:**
- No card PAN handling. Per ADR-0013 the fiat leg is a **2fiat card CVM** with device-only
  custody; this service *asks* that service for a card, it never holds card data.
- No credential storage. The service returns an **account handle**; the secret stays wherever
  the operator puts it.
- No browser automation of OpenAI's captcha. That step is **operator-in-the-loop by design** —
  automating it is what converts an accepted risk into a fraud signal, and it is exactly the
  part most likely to get the account banned before it is useful.

## Experiment protocol (when the operator says go)

1. `account_plan` — read the plan out loud, confirm the throwaway-account posture.
2. Buy the **Flare** card (~$45) and top it up ~$5. **Flare only.**
3. account_advance through requested → email_verified, passing the captcha/OTP by hand.
4. `account_advance` to `payment_pending`; attach the Flare card.
5. **The single charge.** Smallest billable OpenAI amount.
6. Record the outcome verbatim — the decline/approve message, the timestamp, the card.
7. `account_advance` to `charge_verified` or `abandoned`.

**Cost:** ~$50 total, most of it recoverable card balance. Everything except the one charge
is refundable/abandonable.

## Acceptance criteria (falsifiable — decide before running)

| Outcome | Meaning |
|---|---|
| Charge **approves** | Flare funds OpenAI. The 2fiat-funded path is **PROVEN**. |
| Charge **declines** with a card-level message | Flare's copy is **aspirational**. Path refuted for Flare specifically — does **not** re-imply the vendor-wide "no". |
| Charge declines with an **account-level** message | Inconclusive about Flare; the *account* is the problem. Retry once, then stop and report as inconclusive — do **not** buy a second card to chase it. |
| OpenAI **bans** the account | Accepted outcome (D1). Record it, stop, report. A ban is a **result**, not a failure. |

## Guardrails

- **Internal use only** — the posture the operator accepted. Do not dress this up as a
  customer-facing feature.
- **One account, one charge.** No farming, no parallelism, no retry loop.
- **Kill switch:** `account_advance` refuses any transition out of `abandoned`.
- **Never** store or transmit the OpenAI credential through the CVM, a log, or git.
- If any step asks for identity documents, **stop** — that exits the accepted risk envelope
  and needs a fresh operator decision.

## Resume instructions for a future LLM session

1. Read this file, then ADR-0013, then ADR-0008.
2. git log --oneline -10 in contextvm-services; the service skeleton is
   services/openai-account-cvm/ .
3. `cd services/openai-account-cvm && deno test --allow-read` — the lifecycle tests are the
   spec. If they fail, the contract moved; read them before changing them.
4. **Ask the operator before spending anything.** The deferral is deliberate (D6).
5. Do not re-derive the card comparison — it is in the table above, sourced from the vendor's
   own catalogue on 2026-10-10. Re-fetch only if the catalogue may have changed.

## Open questions

- **Q1** Does Flare's "ChatGPT subscriptions and OpenAI API billing" cover **API credit
  purchase** specifically, or only subscription billing? The live charge answers it.
- **Q2** Does the card need a billing-address match with the OpenAI account country?
  Unverified — a plausible silent-decline cause.
- **Q3** Is the phone/OTP step stable across attempts, or does a failed captcha poison the
  number? Unknown; one account per number is assumed.
- **Q4** What is the smallest billable OpenAI amount? Determine at run time, do not guess.

## Explicit non-goals

- ❌ Not a general virtual-card service.
- ❌ Not automating captcha or identity verification.
- ❌ Not touching the operator's existing OpenAI account or key.
- ❌ Not generalising Flare's result to Regular/Wavio (both still **unverified**) or to 2fiat
  as a vendor.
