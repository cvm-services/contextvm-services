# INDEX — what lives where in the cvm-services org

> Single map of the ContextVM (CVM) ecosystem maintained by this operator: which
> repository holds the kit, the registry, the specs, the private services, and
> where each service is deployed and under which systemd unit.
>
> Last verified 2026-10-08. Host labels only (workstation, kit host, registry
> host); no addresses, no machine paths, no keys in this file — this document is
> world-readable.

## The org (github.com/cvm-services)

| Repo | Visibility | What it is | Where its source lives |
|---|---|---|---|
| `cvm-service-kit` | public | The service **kit**: shared library + `services/_shared`, the reference services `cvm-lambda`, `cvm-nanogpt`, `cvm-ppq`, `cvm-sms4sats`, and the Ansible deploy role `deploy/ansible/roles/cvm_service`. | repo root (`lib/`, `services/`) |
| `cvm-registry` | public | The **registry**: collector + cache + the public discovery dashboard that renders allow-listed CVM announcements. | repo root (`collector/`, `site/`, `policy.json`, `curators.json`) |
| `contextvm-services` | public | **Specs + venue CVM services**: ADRs, CEPs and plans (`docs/adr`, `docs/spec`, `docs/plans`) and the venue servers (`services/restaurant-cvm`). | `docs/` + `services/` |
| `cvm-kalman-server` | public | **Data server + its own dashboard**: LLM usage analytics and Kalman burn-rate convergence exposed as MCP tools over Nostr, plus an HTML dashboard and JSON API. Moved into the org 2026-10-08. | repo root (`server.ts`, `dashboard-*.mjs`, `dashboard.html`) |
| `hermes-insights-cvm` | private | CVM server exposing LLM usage analytics as MCP tools. Private by design (embeds operator-local database paths); key material is env-only. | repo root (`src/`) |
| `jlcpcb-service` | private | JLCPCB fabrication/assembly integration as a CVM service — **plan/docs stage**. Phase-1 quoting client complete and reproduced; assembly-quote flow under exploration (`scripts/asm_step*.py` diagnostic run). Not a service yet. | `scripts/`, docs in repo root |
| `nadanada-service` | private | Inbound-SMS inbox as a CVM service (`cvm:service:phone-inbox`; `phone.numbers.list` free, `phone.messages.list` paid via Cashu, message bodies as NIP-44 payloads). Two reader backends: playwright (Cloudflare-blocked) and REST API (needs an API-purchased number). **Not deployed.** | repo root |
| `openai-codex-auth` | private | Reusable OpenAI Codex OAuth **device-code login** client (python module `codex_device_auth`). A credential-lane utility, not a CVM service. | repo root |

## Related repositories outside the org (cross-references)

| Repo | Visibility | Relationship |
|---|---|---|
| `felixfelix-bot/nosms` | public | The SMS service with its own Python CVM (`app/cvm*.py`, `docs/cvm/llms.txt`). Active product repo, deliberately left under its personal account; its CVM surface stays in-repo. |
| `felixfelix-bot/contextvm-services` | private | Archived **duplicate** of this org repo: zero unique commits (its `main` is an ancestor of every org branch). Kept archived with a README pointer; nothing lives there. |
| `felixfelix-bot/cvm-kalman-server` | public | **Former home** of `cvm-kalman-server`, archived 2026-10-08 with a MOVED notice; the live repo is `cvm-services/cvm-kalman-server`. |

## Deployment map (systemd units)

Workstation rows re-verified live 2026-10-08; kit-host and registry-host rows
verified 2026-10-07 during the consolidation audit.

| Service | Host | Unit | State |
|---|---|---|---|
| cvm-kalman-server | workstation | `cvm-kalman-server.service` (user unit) | active |
| venue CVM — doppelt-kaese-berlin | workstation | `venue-cvm-server.service` (user unit) | active |
| venue CVM — pizza-e-pasta | workstation | `venue-cvm-server-pizza.service` (user unit) | active |
| cvm-lambda (+ executor) | kit host | `cvm-lambda.service`, `loom-adapter-firecracker.service`, `loom-egress-deny.service` | active |
| cvm-nanogpt | kit host | `cvm-nanogpt.service` | active |
| cvm-ppq | kit host | `cvm-ppq.service` | active |
| cvm-sms4sats | kit host | `cvm-sms4sats.service` | active |
| cvm-registry collector + dashboard | registry host | `cvm-collector.service` + `.timer`; dashboard behind `cvm.orangesync.tech` | active |
| nadanada-service | — | — | not deployed |
| hermes-insights-cvm | — | — | not deployed |
| jlcpcb-service | — | — | plan/docs only |
| openai-codex-auth | — | — | library, used interactively by design |
| nosms | — | — | in development, no dedicated CVM unit |

## Maintenance

When a repo moves, a service is deployed, or a unit is renamed, update the
matching row here in the same change. Keep this file free of addresses, machine
paths, and key material: the org's public repos are world-readable.
