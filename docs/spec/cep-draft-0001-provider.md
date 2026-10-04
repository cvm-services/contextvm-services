# CEP-DRAFT-0001 — Paid Service Providers over ContextVM (provider-facing)

- **Status:** Draft — for submission to ContextVM as a CEP; number provisional
  (do not cite as an assigned CEP).
- **Type:** Standards Track
- **Requires:** CEP-6 (public announcements), CEP-8 (payments), NIP-01 tags
- **Created:** 2026-10-03
- **Source:** the Bürgermeister use case (restaurant order over CVM), plus the
  fleet's ring-signature trust proofs
- **Companion:** `cep-draft-0002-client.md` — the same protocol from the buyer's
  side. Read both; a provider that satisfies this spec while its client
  counterpart does not is not interoperable.

## Abstract

How a real-world service — a restaurant that takes an order, a car charger that
starts a session — exposes itself over ContextVM so that **any** conforming client
can discover, price, order from and pay it, with no provider-specific client code
and no directory that has to be trusted.

## Motivation

The Bürgermeister demo proved the shape end to end: the buyer never picks a
vendor; the buyer pins a **set** and the provider proves it belongs to it. Doing
that once took a week of integration decisions that are not written down anywhere
— order-then-invoice sequencing, what an expiry means, why a second press is
refused, which tags a relay can actually filter. Every provider re-deriving them
will re-derive them wrong.

Two things must be uniform for a discovery dashboard to exist at all: **the tags
a provider publishes** and **the order/quote lifecycle**. Everything else
(cuisine, plug type, menu schema) is the provider's business.

## Roles

- **Provider** — owns the service and its venue API. One npub, one relay set, one
  MCP server exposing its tools.
- **Facilitator** — the party that quotes, and (optionally) proves membership in a
  pinned registry. It MAY be the same npub as the provider; the spec keeps the
  roles separable so a marketplace facilitator can front several providers.
- **Registry curator** — publishes a pinned set (kind 30000). Not an authority:
  a seed. See `cep-draft-0002-client.md` §Trust.

## Specification — provider requirements

MUST/SHOULD/MAY per RFC 2119.

### P1 — Announce

- **MUST** publish kind `11316` (server announcement, replaceable) and `11317`
  (tools list). `11318`–`11320` **MAY** be used.
- **MUST** keep a stable `d` slug identifying the service instance
  (`berlin-mitte-alexanderplatz-01`) — human-meaningful, not a random id.
- **MUST NOT** invent a new event kind for the listing. The catalog is CEP-6.

### P2 — Tags (the discoverable surface)

- **MUST** publish the namespaced class as `["t","cvm:service:<class>"]`.
  `<class>` is a short lowercase kebab token (`restaurant`, `ev-charger`).
- **SHOULD** add plain `t` words for humans (`["t","burgers"]`, `["t","berlin"]`).
- **MUST** publish location as **geohash at two or more precisions**
  (`["g","u33d"]`, `["g","u33dc0"]`): `#g` is exact-match, so precision must be
  pre-computed by the publisher. Providers with no fixed location **MUST NOT**
  publish a meaningless `g`.
- **SHOULD** publish `["r","<url>"]` for docs/endpoint, and
  `["a","30000:<curator>:<slug>"]` for every registry the provider claims.
- **MUST NOT** rely on a multi-letter tag for anything a client is expected to
  filter on. Multi-letter tags are payload; relays generally do not index them.
- **MUST** verify, for each relay it publishes to, that `#t` and `#g` filters
  actually return its event (see test vectors). A tag that does not match is a
  silent discovery failure.

### P3 — Content

- **MUST** describe itself in the announcement content as JSON: name, about,
  area, currency, opening hours, items/services with a stable `sku`/id and price,
  and the settlement rail.
- **MUST** generate that content from the **same source the venue itself serves**
  (its own API or database). A content copy that drifts from the venue is a
  provider-side bug that no client can detect.

### P4 — Price

- **MUST** advertise price per tool with `cap` tags, one per tool.
- **MUST** ensure the invoice amount equals the advertised `cap` for that tool,
  after unit conversion. Unit mismatches (sats vs msats vs fiat) are the classic
  defect here: the client asserts equality and aborts.
- **MUST NOT** advertise a price it cannot honour right now.

### P5 — Gate payment

- **MUST** use `explicit_gating` for any call that creates a real-world order or
  starts a session. `transparent` is for free or trivially reversible calls.
- **MUST** refuse an unpaid call with `notifications/payment_required` carrying a
  BOLT11 invoice (or another `pmi`-declared method).
- **MUST** be idempotent on `payment_accepted`: a replayed acceptance **MUST NOT**
  execute the tool twice. The order id is the idempotency key.

### P6 — Order lifecycle (the sequence matters)

- **MUST** create the venue's own order first, so the invoice presented to the
  buyer is the **venue's real invoice**. An invoice minted before the order exists
  cannot be reconciled by the venue afterwards.
- **MUST** report the lifecycle honestly; the demo vocabulary was
  `awaiting_payment → pending → paid`.
- **MUST** announce the venue's own order number once the venue issues one. If the
  venue issues none (demo/stand-in mode), the provider **MUST** say so and
  **MUST NOT** imply a real kitchen ticket exists.
- **MUST** label stand-in or non-payable invoices unmistakably (the demo used
  `STAND-IN`), and **MUST NOT** present them as settlement.

### P7 — One action, one message

- The facilitator **MUST** carry the membership proof **inside the quote
  message**, not in a separate exchange. A distinct "prove, then quote" step
  doubles the failure surface and, in practice, loses the operator: they press the
  first button, see nothing, and press again (see P10).
- If the proof is absent or invalid, the missing/refused state **MUST** be
  reported to the requester; the provider **MUST NOT** silently fall back to an
  unproven quote.

### P8 — Freshness window

- Every order **MUST** carry an explicit expiry.
- The expiry is **freshness policy, not the security boundary** (the pin, the ring
  and the one-use key image are). Set it accordingly: a 15-minute window kills a
  live run that was rehearsed earlier. **RECOMMENDED: hours, not minutes**
  (the demo settled on 240 minutes).
- A provider **MUST** refuse an expired order with a reason naming the expiry, so
  the operator sees "expired" rather than "invalid".

### P9 — Order ids are per attempt

- **MUST** mint a **fresh, unique order id per attempt** (`<PREFIX>-<n>`), never
  reuse one across attempts.
- Rationale: replay defence is scoped by `(orderId, setId)`. Reusing an id makes
  a legitimate second attempt look like a replay of the first, and the client
  refuses it **correctly**. The client cannot tell your retry from an attack.

### P10 — Idempotent answering

- The provider **MUST** answer each order **once**. A repeat request for an order
  already answered **MUST** emit no new proof/quote and **MUST** report the
  already-answered state so the operator is told what to do (open a fresh order).
- Rationale, measured: the key image is a property of the **member**, not of the
  order, so a second signature by the same facilitator for the same order is
  refused by any conforming verifier. Emitting that doomed proof is what a user
  reports as "the proof was refused" — i.e. the bug looks like a crypto failure
  when it is a double press.

### P11 — Refusals are data, not silence

- Every refusal **MUST** carry a stable, machine-readable reason string, and the
  provider **MUST** enumerate the refusals its stack can emit. The reference
  implementation's verifier emits eight; each one **MUST** map to a stated
  remedy, and MUST NOT be collapsed into a single "failed".
- Where two sides disagree on the pinned set version, **both** hashes **MUST** be
  reported (`their set … ≠ yours …`). A stale pane must be visible as staleness,
  not as a crypto failure.

### P12 — Membership claims (MANDATORY in v1)

- If the provider claims registry membership it **MUST** publish the `a` tag for
  every registry claimed (P2) **and MUST attach a ring proof**. A bare claim is an
  unbacked assertion and the client treats it as one.
- **The ring (LSAG) proof is the required proof mode.** A plain **BIP340 signature
  by a member key** MAY be attached as an additional claim, but it never
  substitutes: a verifier cannot tell a member's signature from a non-member's by
  inspection, so accepting it is accepting an assertion.
- **The anonymity set size MUST be tracked and published.** Every proof carries
  `anon_set_size` (the number of keys in the pinned set it was drawn from) and the
  ring size.
- A provider whose proof is over a set of fewer than two keys **MUST** declare 1:1
  mode, and **MUST** warn on its own side before emitting a proof that provides no
  unlinkability. A silent ring-of-one that reads as anonymity is a lie the spec
  forbids, and a warning that lives only in a log is not a warning. Warning is not
  refusal: 1:1 is legitimate and must be labelled, never silent.
- **Mandatory is not anonymous.** `anonymity ≤ |pinned set|`; a proof over a
  one-key set is a signature with more arithmetic. The UI MUST NOT render either
  one as privacy the provider does not have.
- A ring proof **MUST** satisfy: ring ⊆ the pinned set, ring size ≥ the client's
  `k_min` (4 floor, 16 RECOMMENDED), no duplicate keys, commitment to the set
  version, and binding to the specific order/announcement.
- Nostr identities are **x-only**: the provider **MUST** publish compressed
  (33-byte) keys in its registry entry, or the verifier must lift `x` with even-y
  consistently. Mixed encodings produce proofs that verify locally and fail
  elsewhere.

### P13 — Availability is advertised, not assumed

- A provider **MUST NOT** advertise a tool it cannot currently serve (closed
  kitchen, charger offline).
- Availability **SHOULD** be readable without placing an order — a cheap tool
  (e.g. `availability`) or an announcement refresh. Stale "open" is worse than
  "unknown".

### P14 — Key and relay hygiene

- **MUST NOT** reuse the settlement/wallet key as the CVM or proof key.
- **MUST NOT** accept a client's secret key for any reason; no provider ever
  needs it.
- **MUST** pass secrets via environment, never as CLI arguments (`--sec` on a
  command line is readable from the process list).
- **SHOULD** publish to at least two working relays; **MUST NOT** assume the
  catalogue relay is up. `relay.contextvm.org` is known unreachable — do not
  depend on it.

## Security considerations

- **A hot key is signing power.** Whoever holds the provider nsec can sign events
  and proofs *as that identity*; the blast radius exceeds one order.
- **Membership attests membership.** It does not attest that the goods will be
  delivered, that funds are clean, or that the provider is solvent. Providers
  **MUST NOT** imply otherwise in their announcement content.
- **Advertising is not vetting.** A `cap` price and a `t` tag are self-declared;
  only the registry claim carries a third party's word, and only for the version
  pinned.
- **Replay.** Without the transaction binding (client side, §C5) a captured quote
  is a bearer instrument.
- **Anonymity is capped by the set** and is a property of the proof, not the
  system: the venue, the courier and the mint all learn the order regardless.

### P15 — Declare the required inputs on the announcement

- A provider **MUST** declare what the *flow* collects from the user as
  namespaced tags on its announcement (11316): `["t","cvm:req:<field>"]` for
  required, `["t","cvm:opt:<field>"]` for accepted-but-optional, and
  `["t","cvm:req:none"]` when the service needs no user-supplied data. The
  register is `docs/spec/service-inputs.md` (machine copy
  `vocab/service-inputs.json`).
- **Declare the flow, not the tool signature.** If the deep-link leads to a venue
  page that asks for an address, that address is required by the flow and MUST be
  declared. An undeclared requirement is discovered by the user at the worst
  moment, which is the failure this rule exists to prevent.
- **Minimisation is a MUST.** A provider MUST NOT require a field it does not use,
  and MUST NOT declare an appetite wider than its flow has. The dashboard renders
  the declared appetite; an inflated one is visible and is a spec violation.
- **Absent is not `none`.** A provider that declares no `cvm:req:*` tag has an
  *unknown* appetite; it MUST NOT be read as needing nothing.
- **Unknown field names fail loud.** A client meeting an unrecognised
  `cvm:req:*` value MUST surface it as an unknown requirement and MUST NOT count
  the service as `cvm:req:none`.
- The full schema (types, patterns, length limits, per-field explanations) belongs
  in the announcement **content**; only the filterable names go in tags (D2).
- The announcement **MUST** also carry exactly one `["t","cvm:tier:<tier>"]` = the
  **maximum** tier among the declared fields (ranks: `none`0 `financial`1 `contact`2
  `fulfilment`3 `legal`4 `sensitive`5). Max-only is what makes a coarse
  "no personal data" query a single server-side `#t` filter (several values = OR);
  publishing every tier present would make "has no sensitive field" unqueryable. The
  tag MUST equal the recomputed max of the provider's own `cvm:req:*`/`cvm:opt:*`
  fields — a tier tag that disagrees with the field list is a spec violation.

## Learnings from Bürgermeister (2026-10-03) — each one became a requirement

- A 15-minute order window died between rehearsal and stage → **P8**.
- The facilitator's single button, pressed twice, produced a second proof that the
  verifier refused by design (key image is per member, not per order) → **P9**,
  **P10**, **P11**.
- The buyer's pane showed the raw verifier string with no remedy → **P11**.
- The invoice had to be the venue's own BOLT11, which forced the order to be
  created before the invoice existed → **P6**.
- Menu content had to come from the venue API, not a fixture, or the demo and the
  kitchen diverge → **P3**.
- Demo-mode invoices were not payable and had to be labelled as stand-ins → **P6**.

## Test vectors

Reference run (demo mode, restaurant "Burgermeister SIM"):

- item `sim-0001` HAMBURGER, €4.37 → **676 sats**; order `po-muscm5l0-0003`;
  invoice `lnbc6760n1p4vpuz2dqqpp5p…`; `amountSats: 676`; status `paid`.
- Facilitator quote = item price + margin (stage value 730 sats).
- Key image reference: a member's key image is **byte-identical across orders**
  (`02762e3d5aa1ec84…` observed for two orders by the same member; a second
  member's differed). Use this to assert P9/P10 behaviour.

## Backwards compatibility

Additive. Providers that never claim a registry and never attach a proof satisfy
P1–P11 and remain discoverable by any conforming client; the trust layer is
opt-in by design.

## Open questions for the CEP discussion

1. Should `cvm:service:<class>` be a closed vocabulary (a registry of classes) or
   free-form with a review process?
2. Should availability get a dedicated announcement field rather than a tool?
3. Do we need a standard menu/item schema, or is that per-provider forever?

