# PLAN — two-phone, sats-paid, real-food order

**Goal:** customer on phone A orders food in a real Berlin restaurant from a PWA;
facilitator on phone B solves the venue's captcha over a mediated session; the
order is paid with sats; the food is collected and eaten. Reliable, secure, and
**no money lost** — ever.

## What actually exists today (measured, not assumed)

| Piece | State |
|---|---|
| Venue menu + basket validation (`restaurant-cvm/server.ts`) | **works** — 188 items, per-method totals |
| Settlement in the venue service | **does not exist** — the header says so: "no settlement, no Lightning, no Cashu, no invoice generation" |
| Browser harness driving the venue checkout | **works to the hCaptcha gate** — cart → Adyen fields → address → `kaufen_clicked` |
| hCaptcha | **human required**, by design. Two attempts at automation failed |
| Fiat card funding (sats → 2fiat virtual card) | **works**, exact-amount, balance-proven ($1.38 → $3.38) |
| Cashu mint | **unresolved** — testnut marks all invoices paid (free ecash); minibits chosen, not wired |
| Customer PWA | **does not exist** |
| Facilitator PWA | **does not exist** (ADR + mockups only) |
| Edge authorization for the VNC socket | **built + proven** (grant gates the WS upgrade, 401/101 measured) |
| Edge authorization **deployed** | **no** |
| Session API listener | **runs**, in-memory only |

So the gap is not "polish". It is: **settlement layer, two UIs, deployment,
persistence**, plus the money-safety guarantees below.

## Money-safety invariants (the point of the whole exercise)

1. **Pay the invoice's own amount.** Never a derived USD/sat rate. The old
   hardcoded rate implied BTC $25.8k against a real $80.2k — a 3.1× overpay.
2. **Journal before the network call.** After a timeout the outcome is
   `outcome_unknown`, which is *not* failure and *not* success. Reconcile against
   the provider's ledger before any retry. Never blind-retry a payment.
3. **No sats into the void.** A mint top-up requires either ecash that is claimed
   or a refund path that is proven. No invoice is paid for value we do not hold.
4. **Paid ≠ confirmed.** An order is only `paid` when the invoice settled *and*
   the venue returned an order confirmation. Between those two events the order
   is `outcome_unknown` and blocks other attempts on the same order.
5. **Every sat has a row.** Each movement has a ledger entry with a provider
   reference. Daily reconciliation must reach zero delta; a non-zero delta is a
   incident, not a rounding note.
6. **Refund path for every failure.** If the venue order fails after the customer
   paid, the customer is made whole. A refund path that has never been executed
   is not a refund path — it must be tested.

## Phases

### P0 — settlement core (no UI)
- Order → invoice with an explicit **payee** decision (see open question 1).
- Exactly-once payment store: journal, `outcome_unknown`, reconcile, refund.
- Property tests: no double-pay under crash/retry; no overpay; no orphan top-up.
- **Exit:** a simulated crash between "sent" and "confirmed" never produces two
  payments, and never marks an order paid.

### P1 — payment adapter to the venue's own rail
- sats → fiat card (proven path) → venue checkout, driven by the harness.
- Receipt + order confirmation captured as evidence, not as a log line.

### P2 — facilitator PWA
- Session list, state, "take control", embedded noVNC (grant in cookie), lease.
- **UX rule:** the captcha is the *only* human step and the UI must say so.

### P3 — customer PWA
- Menu, basket, total, pay, live order state. Shows payment state honestly
  (`outcome_unknown` must be visible, never an optimistic spinner).

### P4 — deployment
- Session API as a systemd unit, `forward_auth` in the real vhost, persistence.
- Secrets from OpenBao at runtime (`fleet_secret.py` / broker), never in files.

### P5 — proof
- Unit + integration + Playwright, **with video recorded**, covering:
  happy path, wrong-facilitator refusal, grant expiry mid-captcha, venue failure
  after payment (refund), duplicate-click on pay.

## Decisions taken (operator did not answer in 10 min; defaults applied, reversible)

Chosen for the failure mode each one makes cheap to recover from:

1. **Fleet wallet receives the sats, then pays the venue by fiat card.** The
   refund window stays open until the venue is actually paid, and this is the only
   path proven end to end today (exact-amount funding, balance-verified).
2. **Customers pay any Lightning invoice** — WebLN, QR, or copy-paste. No account,
   no custody, nothing to top up, so nothing can be stranded in a balance.
3. **Refunds are automatic after a fixed timeout.** Bounded loss, no human
   bottleneck, and no dependency on a facilitator being awake to make someone whole.
4. **OpenBao workstream path** written by an operator-approved broker request and
   readable by `fleet-node-x280`. Until that grant exists, this workstream uses
   `0600` files on this host and the gap is visible in the code, not silent.

Change any of these before P1 and the cost is a rewrite of the adapter, not the core.

## Open decisions (blocking; guessing these loses money)

1. **Who receives the sats?** venue directly / facilitator as merchant of record
   / fleet wallet then card-pay the venue.
2. **What the customer pays with** — Lightning from their own wallet, or our
   hosted flow.
3. **Refund authority** — automatic, or facilitator-approved.
4. **OpenBao path layout** for the NWC/2fiat/venue credentials, and whether a
   `fleet-node-x280` write grant is needed for this workstream.
