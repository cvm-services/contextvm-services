# ADR-0009 — The venue CVM must be able to create an account and log in on a venue's own rail

- **Status:** **Accepted 2026-10-09** — operator requirement after asking whether it exists
  ("Does our contextvm for pizza e pasta handle account creation and login yet? If not, it should").
- **Date:** 2026-10-09
- **Decided:** account creation and login on a venue-owned rail is **in scope** for the venue CVM, as a
  Class 2 capability (ADR-0007) with explicit credential custody — not as a free, announced capability.
- **Tier:** docs/light
- **Depends on:** ADR-0007 (adapter classes), ADR-0001 D12.

## Context

Checked, not assumed: `services/restaurant-cvm/server.ts` (877 lines, Stage 1) exposes exactly two
MCP tools — `menu` and `order`. `order` validates a basket, computes the per-method total and returns
a **hand-off payload** (basket + the venue's own rail + deep link). There is no session, no cookie
handling, no credential store and no auth code of any kind in that file.

So today: **no**, the pizza-e-pasta venue CVM does not create accounts or log in. And some venue
rails need an account before they will take a delivery order — `pizza-e-pasta-ruedesheimerplatz`
presents a login step on its shop, which is what surfaced the question.

## Decision

1. Account creation and login on a venue-owned rail become an explicit capability of the venue CVM,
   implemented as a **Class 2** adapter (ADR-0007): per-venue opt-in, written risk note, no default.
2. **Credentials never enter an announcement.** No `cvm:req:` field for a password, no credential in
   the venue announcement content, no credential in a tool response to a non-owner caller.
3. Custody is decided per venue and recorded: who holds the secret, where it lives, and what the
   blast radius is if it leaks. The default is the private local adapter pattern (the only component
   that ever touches credential material), not the public CVM.
4. These rails automate a **consumer** account. That is a ToS/ban risk and must be stated in the
   venue's record, alongside what happens if the account is lost mid-order.

## Consequences

- A venue that requires an account stops being a dead end, but becomes a venue with a custody
  obligation — which is why it is gated rather than simply added.
- The design (session handling, where the secret lives, how a re-login is detected) is not decided
  here and needs a plan + cold review before implementation.
