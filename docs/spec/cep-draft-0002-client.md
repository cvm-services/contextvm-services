# CEP-DRAFT-0002 — Buying from a Paid Service over ContextVM (client-facing)

- **Status:** Draft — for submission to ContextVM as a CEP; number provisional.
- **Type:** Standards Track
- **Requires:** CEP-6 (public announcements), CEP-8 (payments), NIP-01 tags
- **Created:** 2026-10-03
- **Source:** the Bürgermeister use case (buyer side) + the fleet's ring-signature
  trust proofs
- **Companion:** `cep-draft-0001-provider.md`. A client and a provider are
  interoperable only if both hold up their half.

## Abstract

What a client **MUST** do to find a service, decide whether to trust it, order
from it and pay it — without trusting any directory, without querying a curator,
and without ever handing a key to a provider. The rules that matter are mostly
about **what the client refuses**.

## Motivation

A discovery dashboard is easy to build and easy to build *wrong*. The wrong
version asks a directory who is trusted (a tracking service with extra crypto),
pays whatever invoice arrives (a bearer instrument for whoever got there first),
shows cached data as live, and reports a correct refusal as a crypto bug. The
Bürgermeister run hit the last one on stage. These requirements are the
corrections, written down so the next client does not rediscover them.

## Roles

- **Client / buyer** — discovers, verifies, orders, pays. Holds a wallet; holds
  its own pinned copy of any registry it accepts.
- **Provider / facilitator** — see the companion spec.
- **Relay** — transport only. The client **MUST NOT** treat a relay as an
  authority: it can withhold, reorder and observe.

## Specification — client requirements

MUST/SHOULD/MAY per RFC 2119.

### C1 — Discover by indexed tags, never by scanning

- **MUST** subscribe to `11316`–`11320` with **`#t`**, **`#g`** and `authors`
  filters (plus `since`/`limit` bounds).
- **MUST NOT** filter on a multi-letter tag; if a client needs one, it must
  subscribe broadly first — which is the failure mode this rule exists to prevent.
- **MUST** dedupe replaceable events by `(kind, pubkey, d)`, keeping the newest
  `created_at`, and **MUST** reject a future-dated `created_at`.
- **MUST NOT** call a provider to render a list. Rendering is a cache read; live
  calls are for interaction only. Measured: a CVM call is seconds over relays, and
  parallel calls to fill panels time out.

### C2 — Cache with an honest freshness policy

- **MUST** define a re-read interval and **MUST** fail closed when data is stale:
  disable what depends on it and say so. **MUST NOT** show cached state as live.
- The staleness banner **MUST** name the source and the age, not just "error".

### C3 — Price is asserted, not assumed

- **MUST** display the provider's advertised `cap` price before ordering.
- **MUST** compare the invoice amount against the quoted amount, after unit
  conversion, and **MUST abort** on any mismatch (sats vs msats vs fiat is the
  classic defect).
- **MUST NOT** re-price silently at payment time.

### C4 — Trust: pin once, verify offline

- **MUST** fetch a registry **once**, pin it by **event id + content hash**, and
  verify locally. **MUST NOT** query the curator at order time — a lookup per
  purchase *is* a food diary, and the curator can refuse, rate-limit, price or
  sell what it learned.
- **MUST** reject a set version older than the newest cached, and a future-dated
  registry event (replaceable events can be backdated/forward-dated).
- **MUST** require **ring ⊆ pinned set** — never "the ring contains a trusted
  key". That weaker rule is unsound: an attacker builds a ring from their own key
  plus one scraped trusted key and signs with their own.
- **MUST** enforce `k_min` (4 floor, 16 RECOMMENDED) and reject duplicate keys in
  the ring.
- **MUST** reject non-canonical points before the curve math (x-only lift, even-y).

### C5 — Bind the proof to the transaction the *client* holds

- **MUST** build the bound message from its **own** copy of the order:
  `m = H(domain ‖ orderId ‖ amount ‖ verifier ‖ setId ‖ setHash ‖ expiry ‖
  keyImage)`.
- **MUST** require field-by-field equality **before** the signature check.
  Verifying the payload the provider supplied is a valid signature over a
  self-declared replay — the failure unit tests miss.
- **MUST** test this with a valid signature binding a **different amount** and
  assert the mismatch reason.

### C6 — Pay safely

- **MUST** pay over a declared `pmi` (NWC / Lightning, or Cashu), never by
  improvising a rail.
- **MUST** verify the invoice's **amount** and **payee/destination** against the
  quote before paying, and **MUST NOT** pay when either differs.
- **MUST** obtain explicit human confirmation for a payment. A client **MUST NOT**
  auto-pay, and an LLM-generated artifact may never trigger a payment.
- **MUST** treat a demo/stand-in invoice as non-payable and label it as such;
  showing a "pay" affordance for an invoice that cannot settle is forbidden.
- **MUST** be idempotent: a replayed `payment_accepted` **MUST NOT** cause a
  second payment.

### C7 — A refusal is the feature working, not a crash

- **MUST** distinguish "the proof was refused" from "the crypto is broken", and
  **MUST** surface the verifier's own reason string.
- **MUST** map every reason to the **one action that clears it** (open a fresh
  order, re-pin the set, wait for the window). A refusal with no remedy is a
  defect.
- **MUST** show both set hashes when they disagree (`their set … ≠ yours …`).
- **MUST NOT** retry a refused proof silently. A retry either duplicates an
  already-answered order (refused by design) or masks a real mismatch.

### C8 — Attempt semantics

- **MUST** mint a **fresh order id per attempt** and support re-running the whole
  flow in one session, without restarting the wallet or the host app.
- **MUST** tolerate a provider that answers an order once: requesting the same
  order again expects an "already answered" state, **not** a second proof.
- **MUST NOT** treat the key image as an identifier. It is deterministic per
  member and therefore **pseudonymous, not anonymous** across orders: anyone
  reading a public feed can count "same member, 40 orders" without naming them.

### C9 — Declare what the privacy actually is

- **MUST** state that the anonymity set is capped by the pinned set
  (`anonymity ≤ |pinned set|`) and **MUST** label 1:1 mode as 1:1.
- **MUST NOT** claim anonymity the proof does not provide — in particular when the
  client already knows the provider's npub (it is paying it), a membership proof
  hides nothing and the UI **MUST NOT** imply otherwise.
- **MUST** state the unavoidable floor: the venue, the courier and the mint learn
  the order; the client learns which member served it **only** if the proof is not
  anonymous, and it MUST say which mode it is in.
- **MUST** warn the user when the pinned set holds fewer than two keys (1:1 mode)
  **before** accepting a proof, and **MUST** render the tracked `anon_set_size`
  next to the verification result. The proof is mandatory; at that size it buys no
  unlinkability, so "verified" must never be readable as "anonymous".
- **MUST** treat a missing or unverifiable ring proof as a **failed** membership
  claim, not as "provider did not opt in" — v1 has no opt-out.

### C9a — Interact from an ephemeral npub

- The client **MUST** generate a **fresh ephemeral npub per interaction** (at
  minimum per order) and **MUST NOT** use the customer's identity npub for any CVM
  traffic, order binding or receipt.
- The ephemeral key is generated locally, used for the gift-wrapped transport and
  the order binding, and discarded once the order settles; only what the receipt
  genuinely needs is retained.
- **Why:** the ring protects the provider's member; this is the customer's half of
  the same bargain. Otherwise the provider — and every reader of its relay traffic
  — learns the customer's identity npub together with their purchase history.
- **MUST NOT** claim more than it delivers. Ephemerality covers the CVM layer
  only: a postal address, a phone number or a loyalty field re-identifies the
  customer, and a rail that knows the payer links the order regardless. The UI
  MUST name the link that actually exists instead of implying end-to-end
  unlinkability.
- **Consequence for abuse handling:** no per-identity rate limit or ban is
  possible for customers. Abuse controls live in the order path (per-order key
  image, deposit, refund window), never in an identity blocklist.

### C10 — Failures and money

- **MUST** surface the venue's own error when an order fails after payment, and
  **MUST** present a recovery path (retry, refund request, support) rather than a
  dead-end error.
- **MUST NOT** leave a paid order with no visible state. "Paid but nothing
  happened" is the outcome users report as theft.

### C11 — What the client MUST NOT do

- **MUST NOT** send a secret key (or seed) to a provider, ever, for any reason.
- **MUST NOT** accept a provider-supplied verifier. The verifying code is a fixed,
  reviewed artifact; anything a provider or an LLM generates is **data**
  (registry set, adapter config) that a human reviews. Auto-installing a verifier
  is a key-exfiltration path — wallet hosts already encode this rule.
- **MUST NOT** treat a relay's silence as absence of a service, or its presence as
  truth. Multiple relays; report what was actually queried.
- **MUST NOT** claim a set is "verified" because it was fetched — only because it
  was **pinned and checked**.

## What each party learns (write this table into the client's design doc)

| Design | Curator | Provider | Mint | Third parties |
|---|---|---|---|---|
| asks the curator "is X trusted" | who ordered, when, from whom | — | amount + timing | — |
| pinned set + local verify | **nothing — no query at order time** | the order | amount + timing | only "a member of set X" |
| plain signature by a listed key | nothing | the order | amount + timing | **which member** |

The unavoidable floor: the venue, the courier and the mint learn the order.
Declaring that is what keeps "anonymous" from reading as a promise.

## Security considerations

- **The verifier's ask is the ceiling on privacy.** If the verifier *needs*
  attribution, the ring is the wrong tool — say so instead of shipping a proof
  that cannot deliver it.
- **Removal is always soft.** Nothing can recall a proof already handed over;
  monotonic version acceptance plus a stated expiry is the honest mitigation.
- **Hot keys.** If the provider is an agent holding a hot key, key theft *is*
  signing power, and "non-transferable" means "no passive hand-off", not "a human
  is present".
- **A correct refusal must not read as a failure** (C7). On stage, a double press
  was reported as broken crypto — the failure mode this spec exists to prevent.

## Learnings from Bürgermeister (2026-10-03) — each became a requirement

- Buyer pane refused a proof because the pane had been open through the previous
  rehearsal (the 15-minute window expired) → **P8**, **C8**.
- The refusal was rendered as the raw verifier string, and the operator read it as
  a crypto bug → **C7**.
- Two "test failures" during the investigation were wrong array indices in the
  tests, not app bugs; the pinned verifier was correct both times → probe the
  pinned artifact directly before theorising (see *Test vectors*).
- The order id had to be unique per attempt, otherwise a legitimate second run is
  indistinguishable from a replay → **C8 / P9**.

## Test vectors

- Re-run the whole flow **twice in one session** without restarting the host; both
  runs must reach `paid`. Assert: second proof for the **same** order is refused as
  a duplicate key image; a proof for a **fresh** order verifies.
- Assert the refusal renders as a banner naming the reason **and** the remedy
  (C7) — not only in the logs.
- Assert a ring of `{attacker key, one scraped registry key}`, signed by the
  attacker, is **refused** (C4). Write this RED before implementing.
- Assert a valid proof binding a **different amount** is refused (C5).
- Reference key image: `02762e3d5aa1ec84…` was byte-identical across two orders by
  the same member, and differed from the second member's — use it to prove that
  "one member, one image" is the rule you implemented.

## Backwards compatibility

Additive and opt-in. A client that ignores registry claims satisfies C1–C3, C6
and C8–C11 and still transacts; it simply gains no membership assurance.

## Conformance

Statuses below are the minimum to claim conformance:

- **Provider:** P1–P11 (core) + P13, P14 (hygiene). P12 only if claiming membership.
- **Client:** C1–C3, C6–C8, C10, C11 (core) + C4, C5, C9 whenever any membership
  proof is accepted; a client that shows a proof without C4/C5 is non-conformant
  rather than partially conformant.

## Open questions

1. Should C11's "no provider-supplied verifier" be a hard MUST for every client,
   or scoped to clients that touch money?
2. Is a mandatory `k_min` of 4 too low to call anything anonymous in the UI?
3. Should the client be required to publish which registry versions it pinned, so
   a buyer's choice is auditable?

