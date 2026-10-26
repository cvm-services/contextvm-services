# IaC validation — measured, before anything is applied

**Date:** 2026-10-26
**Question:** the deployment artifacts had never been checked against a real target.
Do they actually work, or do they only look right?

AGENTS.md gate 6 exists because a role once passed syntax checks, tests and review
while carrying three defects that made it useless. This is the same check, applied
to the food-order deployment before it is ever run for real.

## Method

Nothing was installed, no service started, no config reloaded. Units were copied to
`/tmp` on the target and validated with its own tooling.

```bash
scp cvm-session-api.service cvm-customer-api.service vps2fips:/tmp/
ssh vps2fips 'systemd-analyze verify /tmp/cvm-*.service'

# Caddy vhost rendered with throwaway values, validated by the target's Caddy,
# against a synthetic top-level config that mirrors the live global block.
ssh vps2fips 'caddy validate --adapter caddyfile --config /tmp/validate-full.caddy'
```

## Findings — three would-fail-on-start defects

| # | Defect | Consequence if shipped |
|---|---|---|
| 1 | `ExecStart=/usr/bin/deno` | `deno` is at **`/usr/local/bin/deno`** on the target. Unit fails immediately with *"No such file or directory"*. |
| 2 | `User=cvm` | The user **did not exist**. Unit fails at start; the message points at the service, not the cause. |
| 3 | `WorkingDirectory=/opt/cvm/services/restaurant-cvm` | The directory **did not exist**. Same shape of failure. |

All three are invisible to `bash -n`, to a passing test suite, and to review — they
only appear when the thing meets the machine.

## More findings — the deploy script described work it never did

Validating the script's dry run exposed two further defects, both of the same
family: it looked like it did something it did not.

| # | Defect | Consequence if shipped |
|---|---|---|
| 4 | The script **printed** "vhost appended from …" and never appended anything | Caddy would be reloaded and services started with **no route at all**. Everything reports success; nothing is reachable. |
| 5 | `caddy validate --config /etc/caddy/Caddyfile` with no `--adapter` | Caddy assumes JSON and rejects a Caddyfile (`config is not valid JSON`), so validation would always fail — or worse, be skipped by someone "fixing" it. |

Both fixed: the script now renders the template, appends it behind a marker
(idempotent — a second run cannot stack a duplicate vhost), validates with
`--adapter caddyfile`, and **restores the backup and exits non-zero** if validation
fails, before any reload.

## Fixes

- `ExecStart` now uses `/usr/local/bin/deno`, with a comment recording that systemd
  cannot expand `EnvironmentFile` variables there, so the path is literal and must
  be right.
- `p5-deploy.sh` gained a prerequisite phase: create the `cvm` system user, `/var/lib/cvm`
  (0750, owned by cvm), `/opt/cvm/services` and `/etc/cvm`. Idempotent, and it runs
  **before** the units are installed.

## Result after the fixes

```
systemd-analyze verify (on vps2fips)  -> both units clean
                                         (only a pre-existing warning from an
                                          unrelated cdn-node.service)
caddy validate --adapter caddyfile     -> Valid configuration
```

## A lie found in the template's own header

The vhost comment asserted **"THE HOSTNAME IS A SECRET"** and that a VNC password
protected the session. Both were false by the time it was written:

- Let's Encrypt publishes every certificate to Certificate Transparency, so the
  per-session hostname is broadcast before the session exists. It is an *identifier*.
- The password is gone; `forward_auth` gates every request including the WebSocket
  upgrade (measured: 401 without a grant, 101 with).

Corrected in place. A comment that misdescribes the security model is worse than no
comment, because the next person will design against it.

## Not claimed

- **Nothing was deployed.** No unit installed, no user created on the target, no
  Caddy reload, no secret written.
- Validation is not execution: the units are *verifiable*, not *running*. Gate 6 is
  satisfied only when they have been started and their post-condition read back.
