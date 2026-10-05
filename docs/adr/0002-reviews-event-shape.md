# ADR-0002 — Review event shape (kind 30316, addressable)

- **Status:** proposed
- **Date:** 2026-10-05
- **Tier:** docs/light (fleet working agreement: push required, review advisory)
- **Supersedes:** none
- **Related:** ADR-0001 (discovery and trust), `docs/spec/cep-draft-0001-provider.md` (P1/P2/P3)

## Context

`cep-draft-0001-provider.md` defines how a venue announces itself (P1: kinds
11316/11317, "MUST NOT invent a new event kind for the listing. The catalog is
CEP-6"). It says nothing about how a customer states an opinion about a venue.
The operator asked for a review feature; this ADR fixes the event shape before
any code, because the shape is the part that cannot be changed later without
orphaning reviews.

Two things constrain the design, and both were learned the hard way on
2026-10-05 while publishing the two Berlin venue announcements:

1. **`11318`–`11320` are unusable for reviews.** The provider spec allows them
   ("`11318`–`11320` MAY be used"), but everything in 10000–19999 is
   **replaceable** under NIP-16: relays key those events by `(kind, pubkey)`
   alone. For an announcement that is merely awkward — it is why each venue
   needs its own signing key, since two venues sharing one key meant each
   announcement silently overwrote the other. For reviews it is fatal: one
   author would hold exactly **one review across the entire network**, each new
   review overwriting the last, on every relay, with no error surfaced.
2. **Relays index single-letter tags only.** Spec P2 already says this for
   announcements ("MUST NOT rely on a multi-letter tag for anything a client is
   expected to filter on"). The same rule binds reviews.

## Decision

**D1 — Reviews use kind `30316`, in the addressable range (30000–39999).**

Addressable events are keyed by `(kind, pubkey, d)`. With:

- `d` = the venue slug (the announcement's own `d`, e.g. `doppelt-kaese-berlin`)

this yields exactly the semantics a review system needs:

- one review per reviewer per venue, and **editable** by republishing (the
  author's later review replaces their earlier one, which is the behaviour a
  reviewer expects when they fix a typo or update a rating);
- different reviewers never collide, because the pubkey differs;
- different venues never collide, because `d` differs.

The range choice, not the number, is the load-bearing part. `30316` is chosen as
the next free slot after the announcement family; **the number itself needs the
spec owner's ack** and is recorded here as provisional.

**D2 — Reviews bind to the announcement via an `a` coordinate.**

`["a", "11317:<provider_pubkey>:<venue_slug>"]` — the CEP-6 tools announcement
for that specific service instance. Plus `["p", <provider_pubkey>]` and
`["r", <venue_deep_link>]`, which MUST equal the announcement's `r`. The emitter
does not accept these as free arguments: `emit-review.ts` rebuilds the
announcement from the same `venue.json` and reads the slug, URL and geohashes
back out of it, so a review cannot bind to values the venue never announced.

**D3 — The rating is filterable through single-letter tags only.**

- `["t","cvm:review"]` — the class tag, matching the P2 namespaced-class
  convention (`cvm:service:<class>` → `cvm:review`).
- `["t","cvm:rating:<1..5>"]` — the filterable rating.
- `["L","cvm.rating"]`, `["l","<n>","cvm.rating"]` — NIP-32 label form.
- `["rating","<n>","5"]` — **payload only.** Convenient for humans and for
  clients that already hold the event; nothing may filter on it, and no
  contract may depend on it.

**D4 — `g` geohashes are mandatory** (venue reviews are place-bound reviews;
spec P2 already requires `g` for places, and a review that cannot be placed is a
review the map cannot use).

**D5 — An optional `["e", <announcement_event_id>, "", "announcement"]` tag**
records which *version* of the announcement was reviewed. It is a marker for
provenance, not a filter.

## Explicitly NOT decided here

- **Zap weighting** (R3). Reviews are not scored by sats in this ADR. Zaps are a
  spend signal, not truth: they must be shown as a labelled input, never folded
  into a single authoritative score.
- **Proof of place** (R4). Two tiers exist — a venue-signed attestation naming
  the reviewer ("venue-confirmed": proves venue consent, *not* physical
  presence), and an LSAG ring proof over a "customers who visited" set (proves
  membership without revealing which member). Neither is specified here; the
  ring gate (`pr/s4b-ring-gate`) is the prerequisite for the second and is not
  yet merged.
- **Moderation.** No review deletion, no curation. The collector's allow-list
  gates the *reviewer* set, not the opinion.

## Consequences

- A venue page can show reviews without a central server: collect kind 30316,
  filter by the `a` coordinate, sort by created_at, dedupe by
  `(kind, pubkey, d)` (already handled by the addressable semantics — the
  collector's dedupe must prefer the **latest created_at** per coordinate, not
  the first seen).
- Removing a bad review is not possible by design. The honest mitigations are
  the reviewer allow-list and showing reviewer identity + age.
- Adding a review kind to a spec titled "provider requirements" is a spec
  amendment. Until that lands, this ADR is the only normative record, which is
  why §D1 flags the number as provisional rather than settled.
