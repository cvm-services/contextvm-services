# contextvm-services

Paid **ContextVM (CVM)** wrappers around real-world services — a restaurant that
takes an order, a car charger that starts a session — plus a **dashboard** for
discovering such services.

**Status: design + venue catalog.** The specs and ADRs are still drafts awaiting
operator sign-off; the first real venue record now exists under [`venues/`](venues/).

## Venue catalog

`venues/<slug>/` holds one **PR-able directory per venue**: an adapter that reads
the venue's *own* public API, the normalised `venue.json` it produces, and the
evidence (raw responses + rendered page + provenance hashes) the record was built
from. See [`venues/README.md`](venues/README.md) for the rules.

| venue | source | status |
|-------|--------|--------|
| [doppelt-kaese-berlin](venues/doppelt-kaese-berlin/) | `doppelt-kaese-berlin.de` (FoodAmigos storefront) | ✅ 9 sections, 76/76 priced items, idempotent |

The point of the catalog is CEP-0001 §P3: a provider's content MUST be generated
from the same source the venue itself serves. Each adapter here does exactly that
and proves it (price cross-check against the rendered page, hash-stable re-runs).

## Repo split (this org)

Three repos, one axis each — build-side and discover-side fail differently and
have different consumers, so they ship independently:

| Repo | Role | Consumer |
|------|------|----------|
| **`contextvm-services`** (this repo) | Specs · ADR · CEP drafts · `venues/` catalog (data) | implementers, curators |
| [`cvm-service-kit`](https://github.com/cvm-services/cvm-service-kit) | **Library to create** a service (MCP server + CEP-6 announcer + `cap` pricing + optional ring gate) | venue / service owner |
| [`cvm-registry`](https://github.com/cvm-services/cvm-registry) | **Collector**: crawls CEP-6 announcements, dedupes `(kind,pubkey,d)`, caches, serves the discovery dashboard | agents / customers |

Shared types stay a small package inside the kit — no fourth repo until a real
second consumer needs it.

Former location: `felixfelix-bot/contextvm-services` (private; now a stale copy).

- [`docs/adr/0001-discovery-and-trust.md`](docs/adr/0001-discovery-and-trust.md)
  — **Proposed**, needs operator sign-off. How discovery is tagged, what a pinned
  registry is, where ring-signature proofs do and do not earn their keep.
- [`docs/SPIKE-PLAN.md`](docs/SPIKE-PLAN.md) — two spikes with acceptance
  criteria. Classified **SOON** (this week), not NOW; every dispatch starts with
  the quota gate.
- [`docs/spec/cep-draft-0001-provider.md`](docs/spec/cep-draft-0001-provider.md)
  — **provider/facilitator-facing** spec, written so anyone can publish a
  conforming service and be found.
- [`docs/spec/cep-draft-0002-client.md`](docs/spec/cep-draft-0002-client.md)
  — **customer/buyer-facing** spec: what a client MUST discover, verify, refuse
  and pay.
- [`docs/adr/0001-discovery-and-trust.md`](docs/adr/0001-discovery-and-trust.md)
  — the decisions the specs encode.

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

## Mirror, CI and releases on Nostr (ngit)

This repository is mirrored to **ngit** — git hosting and CI on Nostr. The mirror
carries the default branch, every `pr/<slug>` branch and every tag, so the whole
repository is reachable without GitHub.

Clone it over Nostr (the `nostr://` remote speaks the ngit protocol):

```bash
git clone nostr://npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/contextvm-services
git clone https://relay.ngit.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/contextvm-services.git
git clone https://gitnostr.com/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/contextvm-services.git
```

- **Browse / open PRs:** https://gitworkshop.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/contextvm-services
- **CI:** every push is built by [ngit-CI](https://ci.orangesync.tech) — the
  workflows run from the **ngit side**, so the mirror above is the build of record.
- **Announcement (source of truth for the URLs above):** kind `30617`,
  `d=contextvm-services`, by `9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee`, relays: `wss://relay.ngit.dev wss://gitnostr.com`

### Build artifacts (Nostr, not GitHub releases)

Artifacts are published as NIP-94 **kind `1063`** events, not attached to GitHub
releases. Each event carries one `url` tag per Blossom mirror and an `x` tag with
the file's **sha256** — download from any mirror and verify the hash.

No kind-`1063` artifact is announced for this repo yet, so here is the exact query:

```bash
nak req -k 1063 -t "A=30617:9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee:contextvm-services" wss://relay.ngit.dev   # url + x tags
```

When one appears, download from any `url` and prove the `x` sha256 before use:

```bash
echo "<x-tag-sha256>  artifact" | sha256sum -c -
```

---
*Generated by `ngit-readme-section.sh` from the live kind-`30617` announcement
`d9d0d5ff0f6fb663b96d2c029936ce947721f1dc5a87db517cec1059e6b3c459` (created 1791154581). Doc not be hand-edited: re-run the generator.*
