# ADR-0003 — Venue attestations (kind 30317, addressable)

- **Status:** proposed
- **Date:** 2026-10-05
- **Tier:** docs/light (fleet working agreement: push required, review advisory)
- **Extends:** ADR-0002 (review event shape), §R4

## Context

R4 of the review feature is a "proof of place" badge. Two very different things
were being conflated under that name, and only one of them is implementable now:

- **(a) The venue vouches for a reviewer.** The venue signs a statement naming the
  reviewer. Cheap, immediately useful, and it proves exactly one thing: *the venue
  said it*. It does not prove the reviewer was physically present. A venue can
  vouch for its own staff, be mistaken, or sell confirmations.
- **(b) A proof that the reviewer is a member of a "customers who visited" set,
  without revealing which member.** This is what would actually justify a strong
  claim. It needs the LSAG ring machinery, which was still failing its own test
  suite when this ADR was written (`contextvm-services#5`).

## Decision

**Ship (a) now, under a name that cannot be mistaken for (b).**

1. **Kind 30317, addressable**, keyed `d = "<venue_slug>:<reviewer_pubkey>"`.
   The same replaceability constraint as ADR-0002 applies: 10000–19999 is NIP-16
   replaceable keyed by `(kind, pubkey)`, so a venue there could hold exactly ONE
   attestation network-wide and each new vouch would silently erase the last.
   `assertNotReplaceable` enforces this in code and a test covers 11317/11318.

2. **Only the venue's own key counts.** The collector badges a review only when
   the attestation's author equals the pubkey that published the venue's
   announcement. Anyone can publish a kind-30317 event naming anyone; without this
   check the badge is decorative. Attestations from other authors are **counted**
   as `rejected_wrong_author` — never silently dropped, never displayed. A test
   proves a forged attestation yields no badge.

3. **The badge reads "venue-confirmed".** Never "verified visit", never "proof of
   place". The honest limit (`the venue vouched for this reviewer; it is not proof
   the reviewer was present`) travels *inside the data* as
   `ReviewAttestation.limit`, not as UI copy someone can reword, and the E2E
   asserts both that the limit is rendered and that the string "verified visit"
   does not appear.

4. **A badge is not a ranking.** As with zaps (ADR-0002 §R3), attaching an
   attestation does not reorder anything. Newest-first, always.

5. **Self-attestation is refused at construction.** A venue naming itself as the
   reviewer is rejected by `buildAttestation`.

## Refused

- Relabelling (a) as "proof of place". The cryptography does not support the
  claim, and a badge that lies is worse than no badge.
- Implementing a fake (b) — e.g. trusting a venue-signed token as if it were a
  ring proof. (b) stays absent until the ring gate is green, and must then arrive
  as its own kind with its own ADR.

## Consequences

- The claim is bounded and legible: a reviewer appears "venue-confirmed" because
  the venue said so, and a reader can see that is all it means.
- When (b) lands it will need a distinct badge and a distinct kind; the existing
  badge must not be quietly upgraded to mean the stronger thing.
- Reserving 30317 is a spec amendment and needs the spec owner's acknowledgement —
  P1 of the CEP draft forbids inventing kinds for *listings*, and an attestation is
  not a listing, but the omission should be closed in the spec rather than only in
  this ADR.
