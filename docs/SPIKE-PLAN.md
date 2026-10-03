# Spike plan — CVM services discovery + paid call

Companion to `docs/adr/0001-discovery-and-trust.md`. **SOON: this week, not now.**

- **Quota gate first.** Every dispatch in this plan starts with
  `~/.hermes/profiles/manager/scripts/zai-quota-gate.sh`; if it exits 1, the spike
  waits. No `--force`.
- **Where.** Worktree `~/worktrees/cvm-services-spike` (never `/tmp`), branch
  `pr/spike-discovery` (fleet rule D-135: any branch pushed as a PR is `pr/<slug>`).
- **Timebox.** Spike A ≤ 1 day. Spike B ≤ 1 day. If a spike overruns, stop and
  report what is unproven rather than stretching it.
- **Rule for both spikes.** Nothing is "proven" without a command whose output is
  pasted into this file under *Evidence*. A green test that never touches a relay
  is not evidence of relay behaviour.

## Spike A — two services, discoverable by category and location

**Goal.** One restaurant and one EV charger, both announced, both found from a
browser client by `#t` (class) and `#g` (geohash), with no per-service CVM call.

**Steps.**

1. One MCP server per service (tools: restaurant `menu`, `order`; charger
   `availability`, `start_session`). Wrap each with `NostrMCPGateway` →
   `isAnnouncedServer: true`, so CEP-6 kinds `11316`/`11317` are published.
2. Tag both announcements per ADR D2/D3: namespaced `t`, several `g` precisions,
   `d` slug, `a` → a kind-30000 registry event.
3. Publish a kind-30000 registry per category (2 members each, `d` slugs).
4. Browser client (no Node SDK — see the `browser-cvm-client` reference): read
   `11316` with `#t` and `#g` filters, dedupe by `(kind,pubkey,d)`, cache, render.

**Acceptance.**

- [ ] `cvmi discover` lists both services.
- [ ] A relay-side `#t` filter returns exactly the matching service, proven with
      `nak req -k 11316 -t cvm:service:ev-charger <relay>` (exact filter form to be
      confirmed against the relay we use).
- [ ] A `#g` filter at a chosen precision returns the charger and not the
      far-away service.
- [ ] Multi-letter tags are **not** used as a filter anywhere in the client.
- [ ] The dashboard renders from cache with relays unreachable (kill the relay
      connection, reload, list still renders, banner says stale).
- [ ] Recorded: which relays actually index which tags (ADR D2's per-relay check).

## Spike B — a paid call, and the optional ring surface

**Goal 1 (mandatory).** Order from the restaurant over CVM with money attached:
`explicit_gating` → `payment_required` (BOLT11) → pay over NWC → `payment_accepted`
→ the tool runs and the venue records the order.

**Acceptance.**

- [ ] An unpaid call is refused, and the refusal carries a BOLT11 invoice.
- [ ] After payment the same call succeeds, and the tool's side effect is visible
      at the venue (order id recorded).
- [ ] `cap` prices are per tool; the invoice amount equals the advertised `cap`
      for that tool (assert equality — this is where a unit mismatch hides).
- [ ] A replayed `payment_accepted` does not execute the tool twice.

**Goal 2 (opt-in, ring).** One announcement carries a ring proof; a verifier
reusing the fleet's tested LSAG accepts it against the pinned registry.

**Acceptance (write these RED first — they are the whole design).**

- [ ] Non-member attack: `ring = {attacker key, one scraped registry key}` and a
      signature by the attacker key is **REFUSED**. This test exists first, and the
      implementation may not be written until it fails for the right reason.
- [ ] A valid proof over an **altered** announcement is refused (binding).
- [ ] A proof against a **stale** registry version is refused, naming both hashes.
- [ ] A **future-dated** registry event is refused.
- [ ] Ring smaller than `k_min`, or with duplicate keys, is refused.
- [ ] Where an order is involved, a valid signature binding a **different amount**
      is refused by the verifier's own order (not the prover's copy).
- [ ] Linkage measurement: publish two announcements from the same member and show
      whether a third party can link them via the key image — record the answer,
      then decide per surface (ADR D10).

## Out of scope for the spike

- Production admission policy for the registry (who gets in, and why).
- Multi-curator federation, discovery ranking, or search relevance.
- Fiat settlement beyond the venue's existing rail (ADR D5).
- Any round-signature standardisation work (that is the CEP after the spike).

## Decision log (fill while running)

| # | Question | Answer | Evidence |
|---|----------|--------|----------|
| 1 | Which relays index `#t` / `#g`? | | |
| 2 | Exact filter syntax that relay accepts? | | |
| 3 | Cache freshness interval before "stale"? | | |
| 4 | Ring wanted for v1? (rec: no) | | |

## Outcome

To be filled at the end: what is proven, what is not, and what the next PR is.
An unfinished spike reports **what is unproven** — never a green summary of work
that did not reach a relay.

