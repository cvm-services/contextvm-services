# ADR-0016 — 2fiat.com as a ContextVM service (fiat leg of the facilitator flow)

**Status:** Proposed (2026-10-13)
**Context:** CVM facilitated-orders. The sats leg is proven end-to-end; this ADR
adds the missing **fiat leg** so a facilitator can pay a venue's bill
automatically instead of out of pocket.

## Problem

Today the facilitator pays the venue with their own card or cash and records the
venue's order number in the console (ADR-0014). The sats the customer paid land
in a Cashu mint (read-only rail, ADR-0008) and nothing bridges them to the fiat
the venue actually receives. The 8% facilitator fee (`FEE_BASIS_POINTS = 800`,
`src/catalog.ts`) is accounted for in the total but not *collected* into any
instrument the facilitator can spend.

## Decision

Wrap **2fiat.com** (virtual-card wallet) as its own ContextVM service,
`cvm-2fiat`, announced (CEP-6) and priced per call (CEP-8), so the facilitator
console can invoke a fiat payment as a tool call.

### Credential custody (non-negotiable)

The wallet login token lives in **OpenBao** at `secret/data/fleet/2fiat`
(written 2026-10-13, version 1). Nodes read it through a per-node AppRole
(`fleet-node-<node>`, read-only on `secret/data/fleet/*`) per **ADR-020**:

- the token is materialised into a systemd EnvironmentFile at runtime
- it is never in the repo, in a unit file, or on a command line
- the mockups and this ADR reference the path, never the value

### Tools (honest capability set)

- **`cards`** — list the wallet's cards and balances. Read-only.
- **`quote`** — which card, the fiat amount, the fee-inclusive total. No side effect.
- **`pay`** — attempt the venue's fiat payment. **May return a 3DS requirement.**
- **`status`** — poll the recorded reference. Read-only.

Class: **class 2 — authenticated, human-assisted**. A real order action moves
money, so it is payment-authority gated and `explicit_gating` (skill rule 6).

### The 3DS constraint (stated, not hidden)

The wallet's card product is 3D Secure enabled. Fully unattended payment
**cannot be promised**. `pay` therefore returns either a captured state with a
reference, or a `requires_3ds` state with a challenge URL — and never claims
captured without observed evidence. A facilitator-led 3DS approval is an
acceptable and documented part of the flow.

### Transport

The edge silently drops non-browser clients (measured: browser User-Agent gives
200, default User-Agent gives a closed connection with no response). The CVM
must send a browser-like User-Agent and the `ngrok-skip-browser-warning: 5000`
header. This is an upstream transport requirement, recorded in
`docs/2fiat-api-surface.md`.

## Consequences

- The facilitator flow gains one amber block in the console (mockup:
  `docs/mockups/2fiat-console-integration.html`): card, confirmed amount, one
  button, and a queue badge showing which orders still owe fiat.
- PAN and CVV are never read, logged, or returned; only last-four from
  `GET cards`.
- `requires_3ds` is a first-class outcome, not an error to paper over.
- The Lightning rail on the wallet (the btc-currencies list includes BTC LN)
  opens a future path to fund the card from sats directly — out of scope here.

## Alternatives considered

1. **Keep the manual card payment.** Rejected as the end state (automation was
   requested) but retained as the fallback whenever `pay` returns a 3DS
   requirement or the wallet balance is short.
2. **Server-to-server card issuance without 2fiat.** Rejected: no such API was
   found; 2fiat is the instrument the operator already uses.
3. **Unattended-only `pay` that hides 3DS.** Rejected: would break on the real
   product and would mean claiming unobserved success.
