# ADR-0001 — Discovery and trust for paid ContextVM services

- **Status:** Proposed — needs operator sign-off before any feature work
- **Date:** 2026-10-03
- **Tier:** docs/light (fleet working agreement: push required, review advisory)
- **Supersedes:** nothing. First ADR in this repo.

## Context

We want paid **ContextVM (CVM)** wrappers around real-world services — a
restaurant that takes an order, a car charger that starts a session — plus a
dashboard that lets a user *discover* such services.

Half of this is already specified by CVM; the open questions are navigation and
whether provider identity can be *proven* without being revealed.

What CVM already defines (load `contextvm` skill before building):

- **Discovery — CEP-6 public announcements.** `11316` server announcement
  (replaceable), `11317` tools, `11318` resources, `11319` resource templates,
  `11320` prompts. That set *is* the service catalog; `cvmi discover` reads it.
  All traffic rides kind `25910` (ephemeral), encrypted with NIP-17/NIP-59 gift
  wrap (`1059`, `21059`).
- **Payment — CEP-8.** `["cap","tool:<name>","<n>","sats"]` advertises a price
  per tool; `pmi` tags declare the method (`bitcoin-lightning-bolt11`,
  `bitcoin-cashu`); the lifecycle is `transparent` or `explicit_gating`; a gated
  call returns `notifications/payment_required` with a BOLT11 invoice, the client
  pays over **NWC**, and the call proceeds on `payment_accepted`.

So the paid wrapper is a `NostrMCPGateway` in front of the venue's existing MCP
server plus `cap` tags. What is genuinely open: **category + location
discovery**, and **what a provider can prove about itself**.

## Decisions

Each decision carries a recommendation; the operator picks the disputed ones.

### D1 — Discovery rides on the CEP-6 announcement kinds; no new listing kind

**Decision.** A service announces itself with `11316` (+ `11317` for its tools).
Category and location are expressed as **tags**, not as a new event kind.
**Why.** A new kind fragments the catalog and every CVM client would need to
learn it. Tags are additive and existing clients still see the service.
**Rejected.** A parallel "directory" kind, or a central index server: the second
is a curator by another name (see D4).

### D2 — Filterable fields MUST be single-letter tags

**Decision.** Anything the dashboard filters on server-side goes in a
single-letter tag: `d`, `t`, `g`, `k`, `r`, `a`, `p`. Structured detail lives in
the announcement **content** JSON. Multi-letter tags (`service`, `category`,
`charger_type`) are payload only, never the filter.
**Why.** Standard relays index single-letter tags for `#x` filters; multi-letter
tags are not filterable in practice. Filtering on one means downloading the
firehose first — it does not scale, and it fails differently on every relay.
**Per-relay check before relying on it:** confirm the relays we use index the
tags we choose (strfry / nostr-rs-relay settings differ). Record the answer here.

### D3 — Class taxonomy via namespaced `t` values; geo via multi-precision `g`

**Decision.**

- `["t","cvm:service:ev-charger"]` — namespaced class, collision-free against the
  firehose's `t=charger`.
- `["t","ev-charging"]`, `["t","berlin"]` — plain category/geo words for humans.
- `["g","u33d"]` **and** `["g","u33dc0"]` — geohash published at **several
  precisions**, because `#g` is exact-match; the publisher pre-computes
  precision, the client cannot ask for "near".
- `["d","berlin-mitte-alexanderplatz-01"]` — stable per-service slug.
- `["r","https://…"]` — endpoint / docs.
- `["a","30000:<curator>:ev-charging-berlin"]` — the registry version claimed.

**Why.** Namespacing keeps the taxonomy ours while the filter stays a plain `#t`.
**Verify first.** NIP-52 (`g` geohash), NIP-89 (`k` handler announcements) and
NIP-15/NIP-99 (listings) already define tag semantics; reuse them rather than
minting a third vocabulary. Read the NIP text before writing code — do not trust
this ADR for the exact letter meanings.

### D4 — One pinned registry per category, one curator each; no global authority

**Decision.** A trust registry is a NIP-51 **kind 30000** list with
`d=<category>-<area>` (`ev-charging-berlin`, `restaurants-berlin`). Every
curator runs their own; a client fetches a curator's list **once**, pins it by
**event id + content hash**, and verifies offline.
**Why.** Curating a set *is* making a vetting claim, so a set can never speak for
another operator's vendors. Also: pinning means **no lookup at order time** — a
trust mechanism that phones the list owner per purchase is a tracking service
with extra crypto, and the owner can refuse, rate-limit or sell what it learned.
**Consequence.** A "coordinator" list is a copyable bootstrap **seed**, never an
authority. Admission policy is the hard part; the crypto only says *the set owner
vouched for this key*.

### D5 — Price per tool (`cap`), method via `pmi`, `explicit_gating` for real orders

**Decision.** Anything that creates a real-world order or starts a session is
`explicit_gating`. `cap` prices the **call**, per tool.
**Honesty clause.** Pricing a call is **not** settling the goods. For a burger or
a charge session the venue's own rail settles and CVM only *authorizes*. These
two words stay apart in every artifact, or the system reads as a payment system
it is not.
**Rejected.** `transparent` gating for physical fulfilment (the call would
succeed before the money is certain).

### D6 — The dashboard is an aggregator + cache, never a live query engine

**Decision.** Bulk-read announcements, cache to a local index, dedupe
replaceable events by `(kind, pubkey, d)` keeping the newest `created_at`. Live
CVM calls are for **interaction only** (open menu, start session).
**Why.** Measured on this fleet: a CVM call is seconds over relays and ~0.7 s
warm; eight parallel calls to fill panels time out. A read-only display can also
subscribe to a public snapshot event instead of holding a browser key.
**Consequence.** Discovery latency is cache-bound, so the ADR must state a
freshness policy (re-read interval) and what the UI shows when the cache is
stale. Stale must **disable**, never silently show old state as live.

### D7 — Ring proofs are OPT-IN, and only where member↔action linkage must break

**Decision.** Default is a plain **BIP340 signature by a member key** over
`H(announcement ‖ order ‖ amount)` — constant size, no new crypto. A ring proof
(LSAG over a pinned set) is used only where the *unlinkability of the member from
the act* is the point.
**Where it earns its keep.** The registry is public, but a passive relay reader
must not be able to say **which** member announced or served a given session —
"one of the certified set did this", attributable to nobody. Verification is
local against the pinned set, so no curator phone-home (D4).
**Where it buys nothing.** A client calling a service directly already knows the
npub it is paying. A ring there hides nothing and costs ~`4n` multiplications and
`32n+65` bytes. Say this out loud in the UI rather than implying privacy.
**Anonymity is capped and declared:** `anonymity ≤ |verifier's pinned set|`. Never
pad a ring with decoys — every ring member must be one the verifier accepts,
otherwise a non-member can sign.

### D8 — Soundness rules, if a ring is used

**Decision.** The verifier accepts only when **ring ⊆ pinned set** (with a
minimum ring size: 4 floor, 16 for production), never "the ring contains a trusted
key". The proof must:

- commit to the **set version** (event id + content hash); reject a version older
  than the newest cached;
- reject a **future-dated** `created_at` on the registry event (replaceable
  events can be published with a future timestamp);
- bind the act: `m = H(domain ‖ announcement/order id ‖ amount ‖ verifier ‖
  set id ‖ set hash ‖ expiry ‖ key image)`;
- reject duplicate keys in the ring and enforce the minimum size;
- where money moves, hold the **verifier's own** copy of the order and require
  field-by-field equality *before* the signature check. Verifying the payload the
  prover supplied is a valid signature over a self-declared replay.

**Test it RED first:** a non-member builds `ring = {their key, one scraped
trusted key}` and signs; that test is the regression suite for the whole design.

### D9 — x-only keys: Nostr npubs are x-only, LSAG needs full points

**Decision.** The registry publishes **compressed (33-byte) public keys**, or the
verifier lifts `x` with even-y and negates the scalar consistently between sign
and verify. Non-canonical points are rejected before the math runs.
**Why.** nostr identities are BIP340 x-only; mixing encodings produces proofs that
verify locally and fail everywhere else. This cost real time in the demo —
budget it, do not discover it.

### D10 — Key image scoping and the pseudonymity we must confess

**Decision.** If a key image is used, scope the seen-set **per order/epoch**, not
globally, and document the trade: one key has **one** image, so a public feed can
count "same member, 40 sessions" without ever naming them. Where receipts are
public or aggregated, prefer plain SAG (no key image).
**Consequence.** Replay defence and unlinkability pull in opposite directions;
the ADR picks per surface, and the UI states which one the user is getting.

### D11 — Standardise the taxonomy as a CEP *after* the spike

**Decision.** Ship the spike on the indexed letters above (D2/D3), then propose a
**CEP** for service classification + location so the tag gets spec'd rather than
staying a private convention. Check NIP-89 / NIP-15 / NIP-99 / NIP-52 overlap
first and reuse their semantics.
**Why.** A discovery tag's entire value is "do other clients' relays index it". A
private tag that only our dashboard understands is a directory with extra steps.

## Consequences

- **Positive.** No new event kinds; existing CVM clients keep working. Discovery
  is a cache read, so the dashboard stays fast. The trust layer is opt-in, so the
  simple path (signature by a listed key) has no new crypto to review.
- **Negative / accepted.** Geo requires the publisher to pre-compute several
  geohash precisions. Cache staleness becomes a real product concern (D6). Ring
  proofs, when used, add a custom verification path with no standardised Nostr
  primitive behind it — vendor and review that code, do not hand-roll it.
- **Explicitly not claimed.** Membership attests *membership*. It does not say the
  funds are clean, the order will be delivered, or the provider is solvent.

## Open questions (operator input wanted)

1. **Public or private dashboard first?** A public feed is a relay-read; a
   private one needs a key in the browser (see D6).
2. **Who curates the first registry** — us, a partner, or per-user local sets?
3. **Fiat settlement:** does the venue's own rail settle (as in the last demo), or
   is CVM meant to carry the whole payment? This changes D5's framing.
4. **Is the ring wanted at all for v1?** Recommendation: **no** — ship D7's plain
   signature, keep the engine for the surface where linkage matters.

## References

- `docs/SPIKE-PLAN.md` — the two spikes with acceptance criteria.
- Skills (load before building): `contextvm`, `ring-signature-trust-proofs`,
  `contextvm` → `references/browser-cvm-client.md`, `dashboard-architecture.md`.
- Fleet rules: `~/.hermes/AGENTS.md` (definition of done, `pr/` branch prefix,
  push policy), `urgency-aware-dispatch` (this ADR is SOON, not NOW).

