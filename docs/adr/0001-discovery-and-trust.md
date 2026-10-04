# ADR-0001 — Discovery and trust for paid ContextVM services

- **Status:** **Accepted** — operator sign-off 2026-10-04 (the four open questions are answered; see *Decisions taken*). Ring posture was revised at sign-off from opt-in to **mandatory with a declared set size** (D12).
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
**Settled (2026-10-04).** Dashboard #1 is **public** and hosted behind a
subdomain of `orangesync.tech` (candidate `cvm.orangesync.tech`). It renders
**only** announcements from the curator allow-list (D12a) — the allow-list is the
curation, the cache is just plumbing.

### D7 — Where a ring proof earns its keep (superseded in force by D12)

> **Amended 2026-10-04 by D12.** The ring is **mandatory** in v1, not opt-in.
> This section still explains *why* the construction exists and where it buys
> nothing; D12 governs *when it is required* and *what must be declared*.

**Decision (original, now amended).** Default is a plain **BIP340 signature by a member key** over
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
**Status.** Drafts now exist — `docs/spec/cep-draft-0001-provider.md` (provider /
facilitator facing) and `docs/spec/cep-draft-0002-client.md` (customer facing),
both derived from the Bürgermeister run. Submission to ContextVM still follows a
spike that proves them; the numbering is provisional and MUST NOT be cited as an
assigned CEP.

### D12 — The ring proof is MANDATORY in v1, and its set size is tracked and warned on

**Decision (operator, 2026-10-04).** Every provider membership claim carries a
**ring (LSAG) proof over the pinned set**. A bare claim, or a single-key
signature, does not satisfy it. This supersedes D7's opt-in default: uniform
mandatory proofs remove the downgrade path where a client accepts whatever proof
shape happens to arrive.

**The anonymity set size is a first-class, published field.** Every proof carries
`anon_set_size` (keys in the pinned set it was drawn from) and the ring size. When
`anon_set_size < 2` — a one-key set — the provider **MUST** declare 1:1 mode, and
**both counterparties MUST be warned**: the provider before emitting a proof that
provides no unlinkability, the client before accepting one. A warning that exists
only in a log is not a warning. **Warning is not refusal** — 1:1 is legitimate and
must be labelled, never silent (D7's honesty clause still stands).

**Mandatory ≠ anonymous.** `anonymity ≤ |pinned set|`; a proof over a one-key set
is a signature with more arithmetic. Nothing in the UI may render either as
privacy the system does not provide.

**Why mandatory despite the cost.** Opt-in proofs created two classes of service
and the client could not tell which one it was talking to; a mandatory proof is
the only version where the verifier's check (`ring ⊆ pinned set`) is always
exercised, which is where the real security value is. The cost (`4n`
multiplications, `32n+65` bytes) is accepted.

### D12a — The dashboard renders only allow-listed npubs, hardcoded per deployment

**Decision (operator, 2026-10-04).** The registry keeps a **hardcoded list of
npubs** whose announcements the dashboard may render; it is committed in the repo
(`cvm-registry/curators.json`) so **a fork edits the list rather than the code**.
No runtime fetch, no admin UI, no dynamic trust: changing the list is a commit and
a redeploy. An unknown npub is **not rendered** (fail closed), and an empty list
renders nothing at all.

**Why.** Curation is a claim, so it must be auditable in the deployer's own git
history, not in a database someone can edit quietly. It also makes the
"who curates registry #1" answer concrete: **we do**, one curator, one file,
delegation added later if a second curator ever exists (D4's no-global-authority
rule still holds — a fork with a different list is a different curator, not a bug).

### D13 — The customer interacts from an ephemeral npub

**Decision (operator, 2026-10-04).** The client generates a **fresh ephemeral
npub per interaction** (at minimum per order) and never uses the customer's
identity npub for CVM traffic, order binding or receipts. The key is generated
locally, used for the gift-wrapped transport and the order binding, and discarded
once the order settles.

**Why.** The ring protects the *provider's* member; this is the customer's half of
the same bargain. Without it the provider — and anyone reading its relays —
learns the customer's identity npub together with their purchase history.

**Accepted limits, which the UI MUST state.** Ephemerality covers the CVM layer
only: a postal address, a phone number or a loyalty field in the order
re-identifies the customer, and a payment rail that knows the payer links the
order regardless. And no per-identity rate limit or ban is possible for
customers, so abuse control lives in the order path (per-order key image,
deposit, refund window), never in an identity blocklist.

### D14 — A standard register of input field names, carried on `t=cvm:req:<field>`

**Decision (operator, 2026-10-04).** The `contextvm-services` repo owns a
**growing, additive register of input field names** —
`docs/spec/service-inputs.md` with the machine-readable twin
`vocab/service-inputs.json`. Services declare what they require from the user as
namespaced values on the existing `t` tag: `cvm:req:<field>` (required),
`cvm:opt:<field>` (optional), and the sentinel `cvm:req:none`. The dashboard
filters on that, so a user can ask "needs no personal data" **before** handing
anything over.

**Why on `t` and not a new letter.** Additions are new *values*, so a growing
list never becomes a growing tag alphabet, and the filter stays a plain `#t`
(D2/D3).

**The AND limitation, stated up front.** Several values for one tag letter in a
single `REQ` are **OR**, never AND — no filter can express "requires an address
*and* a phone". The relay filter is therefore a **coarse prefilter** and the AND is
done locally on the cache (D6). A client that reports a match count without the
local AND is wrong, not merely imprecise.

**Tiers.** Every field carries a tier (`none`, `financial`, `contact`,
`fulfilment`, `legal`, `sensitive`) so "no personal data" is defined once in the
register rather than re-invented per dashboard.

**Honesty rules.** A service declares what the **flow** collects — including what
the venue's own page will ask for after the deep-link — not merely what its tool
signature needs. It MUST NOT require a field it does not use. An unknown
`cvm:req:*` value fails **loud**: shown as an unknown requirement, never counted
as `cvm:req:none`. And **absent is not `none`**: a service with no requirement
tags has an *unknown* appetite and is grouped as unclassified.

**Consequence.** The register is shared vocabulary, so the kit and the registry
both read `vocab/service-inputs.json`; a private convention here would be a
directory with extra steps (cf. D11).

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

## Decisions taken (operator, 2026-10-04)

1. **Dashboard: public**, behind a subdomain of `orangesync.tech` (D6).
2. **Curator: us, one list**, held as a **hardcoded allow-list of npubs committed
   in the repo** so a fork changes the list at deployment (D12a).
3. **Fiat: v1 keeps D5's split** — the venue's own rail settles, CVM authorizes and
   deep-links. A CVM-carried paid order (BOLT11/Cashu) is v2.
4. **Ring in v1: YES, and mandatory**, with the anonymity-set size tracked and a
   warning to **both** counterparties when the set holds fewer than two keys
   (D12). This supersedes the earlier "opt-in, recommend no" posture.
5. **The customer uses an ephemeral npub** per interaction (D13).

## References

- `docs/SPIKE-PLAN.md` — the two spikes with acceptance criteria.
- `docs/spec/cep-draft-0001-provider.md` — provider/facilitator-facing spec.
- `docs/spec/cep-draft-0002-client.md` — customer/buyer-facing spec.
- Skills (load before building): `contextvm`, `ring-signature-trust-proofs`,
  `contextvm` → `references/browser-cvm-client.md`, `dashboard-architecture.md`.
- Fleet rules: `~/.hermes/AGENTS.md` (definition of done, `pr/` branch prefix,
  push policy), `urgency-aware-dispatch` (this ADR is SOON, not NOW).

