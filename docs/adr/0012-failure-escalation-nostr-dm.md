# ADR-0012 — A failed or duplicate fiat leg escalates over Nostr DM, never silently

- **Status:** **Accepted 2026-10-09** — operator decision ("the contextvm should have an option to
  provide support via nostr DM in such situations").
- **Date:** 2026-10-09
- **Decided:** when sats are final and the fiat leg fails, or a duplicate order is possible, the CVM
  **initiates** support over Nostr DM **to its operator** - the CVM is the actor, not an inbox someone
  is expected to watch - as part of the order's durable state. The run-1 loss stays with the operator,
  capped at EUR 30, but it is a notified loss, not a silent one.
- **Operator refinement 2026-10-09:** "the contextvm should have an option to initiate support via
  nostrdm to its operator in such situations" - initiation and the operator as recipient are the
  required parts.
- **The operator identity already exists: no new support identity is needed.** `cvm-2fiat` takes
  `OWNER_NPUB_HEX` (secret, env) and `assertOwner()` gates the owner-only `card.balance` on exactly
  that key (`services/cvm-2fiat/src/tools.ts`). The escalation writes to the same owner identity. A
  second, separately-managed "support npub" would be a second thing to rotate and lose.
- **Tier:** docs/light
- **Depends on:** ADR-0008 (real sats + fiat gate), ADR-0011 (declared inputs), ADR-0004.

## Context

The adversarial critical-path review put one question in front of code: who is merchant of record,
and who pays when sats settle but the fiat checkout fails, or when the same order is delivered
twice. The honest defaults (manual refund; operator bears a small first-run loss) were already
recorded - but a manual procedure with no notification is a loss nobody sees. This ADR supplies the
missing half: an escalation path.

## Decision

1. **Terminal failure emits an escalation.** Any state where sats are final and the fiat action did
   not complete - or where a second fiat attempt against the same payment was prevented or detected -
   sends a Nostr DM to the **support npub** (the owner): intent id, order hash, sats proof (payment
   hash/preimage reference), rail, amount, fiat cap, and what specifically failed.
2. **Never card material.** No PAN, CVV, expiry, OTP, session or cookie in a support message - the
   2fiat scope (`2fiat-local-adapter/docs/SCOPE.md`) stands. Hashes and ids only.
3. **The customer gets a thread too.** The customer's npub receives a DM stating the state plainly
   and what happens next (refund pending / retry / no charge). A one-sided escalation leaves the
   customer with a paid order and no explanation.
4. **Replies are inputs, not chat.** A DM reply from the owner or the support contact updates the
   order's **durable state** (e.g. "refunded" -> terminal `refunded`), so a resolution is recorded
   rather than remembered. This is why the escalation belongs to the settlement state machine
   (card `t_89dcb160`) and not to a logging helper.
5. **Transport:** NIP-17 private DMs preferred, NIP-04 acceptable. Note the replay caveat: the kit's
   current suppression is an in-memory event-id cache with a 10-minute TTL (see ADR-0008 and the kit
   defect card `t_e19ad2e9`). A support DM must therefore never be the only replay barrier for any
   action it triggers.
6. **An unanswered escalation is an open loss, so it must be observable.** Sending the DM is not the
   end: an escalation with no resolution within a bounded window raises an alert. A support channel
   that quietly accumulates unread failures is worse than no support channel, because it looks like
   one.

## Consequences

- Support needs a concrete identity: a **support npub** the service can write from, and a defined
  place where support threads are read (today this is the manager CW's Signal/Nostr side).
- The customer persona needs an npub to be DMed at; where a customer has none, the declared-inputs
  route (ADR-0011) has to say so rather than inventing one.
- Run-1 economics unchanged: the operator bears a settled-sats/failed-fiat loss up to EUR 30.
