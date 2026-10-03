# contextvm-services

Paid **ContextVM (CVM)** wrappers around real-world services — a restaurant that
takes an order, a car charger that starts a session — plus a **dashboard** for
discovering such services.

**Status: design only.** No feature code yet.

- [`docs/adr/0001-discovery-and-trust.md`](docs/adr/0001-discovery-and-trust.md)
  — **Proposed**, needs operator sign-off. How discovery is tagged, what a pinned
  registry is, where ring-signature proofs do and do not earn their keep.
- [`docs/SPIKE-PLAN.md`](docs/SPIKE-PLAN.md) — two spikes with acceptance
  criteria. Classified **SOON** (this week), not NOW; every dispatch starts with
  the quota gate.

## What this is

- Discovery rides on CVM's existing CEP-6 announcements (kinds `11316`–`11320`);
  category and location are **tags**, not a new event kind.
- Payment rides on CEP-8 (`cap` prices, `pmi` methods, `explicit_gating`).
- The dashboard is an **aggregator + cache** over announcements. Live CVM calls
  are for interaction only.

## What this is not

- Not a settlement system. `cap` prices the *call*; the venue's own rail settles
  the goods. The ADR keeps those two words apart on purpose.
- Not a global vendor registry. Registries are kind-30000 lists, one curator each,
  pinned by content hash and verified offline — never queried at order time.
- Not private by default. A ring proof is opt-in and only used where linking a
  member to an action is the thing to prevent; anonymity is capped by the set and
  declared in the UI.

## Before building

Load the `contextvm` and `ring-signature-trust-proofs` skills. Fleet rules
(`pr/` branch prefix, definition of done, push policy) live in the working
agreement at `~/.hermes/AGENTS.md`. Worktrees go in `~/worktrees/`, never `/tmp`.
