# INDEX — what lives where in `cvm-services`

One page answering "where does X live?" for the sats-paid services platform.
Generated 2026-10-15 by the manager during the org consolidation.

## The customer-facing flow, end to end

```
customer                    facilitator                 venue
--------                    -----------                 -----
cvm-registry  (PWA: order/)  cvm-orders (console)  ──▶   FoodAmigos checkout
     │                            │                            │
     └── Lightning invoice ───────┤                       (online card payment)
         (cvm-orders /invoice)    │
                                  └── settlement sweep (paid → placing → placed)
```

## Repositories

### The platform — this project

| repo | visibility | what it is |
|---|---|---|
| `cvm-orders` | public | Order lifecycle service: server-side pricing (`priceOrder`), Lightning invoice + settlement sweep, queue, melt-plan, refund leg (**not yet wired**), `venue_not_supportable` gate. Deployed to `testserver2` as `/opt/tollgate/cvm-orders`. |
| `cvm-registry` | public | The PWA (customer `/order/`, facilitator `/console/`) + the menu collector that crawls ContextVM services. Hosts `site/menu.json`, `config/venues.json`. |
| `contextvm-services` | public | ADRs (0001–0020) + the **restaurant/CVM specs** + `venues/<slug>/venue.json` records + the restaurant-cvm server. The SoT for *what a venue declares*. |
| `cvm-service-kit` | public | Library for building CVMs (MCP server base, shared gate). Contains `services/cvm-2fiat/` (**the rail, not the card** — see below), `cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`, `cvm-lambda`. |
| `cvm-kalman-server` | public | Data server + live dashboard for LLM usage/cost (Kalman price routing). |
| `nosms` | public | Permissionless Cashu-paid SMS/OTP rail. |
| `mcp-cashu-exchange` | public | Modular MCP service exchange: registry, gateway, payment rails for payable services (charging, food). |
| `merchant-routing-engine` | public | Merchant/venue routing. |
| `merchant-routing` | **private** | Fleet lane repo (D-128) for the `merchant-routing` board — operational work, not platform code. |
| `napplet-trust-checkout` | **private** | NIP-5D napplet trust-checkout. |
| `sms-gateway` | public | Provider-agnostic SMS gateway (Telnyx, MSG91, Fast2SMS). |
| `electrum-napplets` | public | **Stale fork** of `DhananjayPurohit/electrum-napplets` — 0 unique commits (ahead 0 / behind 12 as of 2026-10-15). Kept for reference; no work of ours. |

### Card material — handle with care

| repo | visibility | what it is |
|---|---|---|
| `2fiat-local-adapter` | **private** (must stay so — enforced by `tests/test_repo_visibility.py`) | The ONLY component that ever reads a PAN/CVV. Local-only: no listener, no Nostr identity, no announcements. Reads one card's details for one checkout, fills the merchant page, **stops at the human 3DS prompt**. Scoped, **not built** — see `docs/SCOPE.md`. |

### Private services (not part of the customer flow)

| repo | visibility | what it is |
|---|---|---|
| `openai-codex-auth` | private | Device-code OAuth for an existing OpenAI account. Refuses account creation by design. |
| `jlcpcb-service` | private | JLCPCB fabrication/assembly CVM. |
| `nadanada-service` | private | Nadanada service CVM. |
| `hermes-insights-cvm` | private | CVM exposing LLM usage analytics. |
| `tollgate-dashboard` | private | TollGate maintainer nsite dashboard. |
| `cashu-me` | public | Fork/mirror of the cashu.me wallet PWA (upstream: `cashubtc/cashu.me`). |

## The three-component card story (do not conflate these)

1. **`cvm-service-kit/services/cvm-2fiat/`** — a *rail*. Quotes a payment, validates
   an https merchant checkout URL, reads the owner's balance. **No authorize
   endpoint exists upstream**, and the contract hard-refuses `card.details` and
   `payment.authorize`. It never sees card material.
2. **`2fiat-local-adapter`** (private) — the only thing that reads card values, on
   the operator's own machine, for one payment at a time.
3. **The 3DS stop** — on spend, a human completes SCA. This is by design, not a
   missing feature. See `hermes-orchestration/docs/plans/GAP-openai-account-automation-2fiat-payments-2026-10-09.md`.

## Deployment map

| what | where |
|---|---|
| `cvm-orders` service | `testserver2:/opt/tollgate/cvm-orders` (systemd `cvm-orders`) |
| venue CVM servers (6) | x280 `venue-cvm-server-<slug>.service` |
| `fiat-cvm` | x280 `fiat-cvm.service` (2fiat rail, ADR-0016) |
| PWA (customer + console) | `https://cvm-pwa.orangesync.tech/order/`, `/console/` |
| menu + catalog | `https://cvm-pwa.orangesync.tech/menu.json` |
| 2fiat wallet token | OpenBao `secret/data/fleet/2fiat`, field `token` (never in source) |

## Not moved here on purpose (2026-10-15)

- **`felixfelix-bot/cashu.me`** — a fork of `cashubtc/cashu.me` whose commits are
  **already all present in `cvm-services/cashu-me`** (verified by SHA). A transfer
  would also collide: GitHub normalises `.` to `-`, so `cashu.me` and the existing
  `cashu-me` are the same name. Redundant — left alone.
- **`cvm-services/cashu-me`** — the real cashu.me work: Nostr-key wallet + a
  Cashu-paid CVM services marketplace (SMS/WhatsApp).

## Related repos outside this org

- `felixfelix-bot/hermes-orchestration` — fleet governance, kanban state, AdRs, deploy roles.
- `felixfelix-bot/contextvm-services` — **private duplicate** of the org repo name; slated for archival with a pointer here (card `t_4549a32f`, item P2).
- `2fiat-local-adapter` — moved INTO this org 2026-10-15 (was `felixfelix-bot/…`).
