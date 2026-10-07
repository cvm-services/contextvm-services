# ngit CI for contextvm-services

`.ngit/act/workflows/ci.yml` is the Nostr CI lane. It exists because the code tier is otherwise
unverifiable: the repo carries no `.github/workflows`, so
`ngit_ci_evidence.py contextvm-services --commit <sha>` could never find a kind-9842 result and
every card on the `contextvm-services` board was structurally blocked at the code tier (operator
card `t_5de8e74f`).

Nostr CI reads `.ngit/act/workflows/` **only** — `.github/workflows/` is detected but never executed
— so adding this file cannot disturb a GitHub lane (and none exists here).

## What it runs

Exactly the checks `deno.json` declares, so the workflow cannot drift from the repo's own definition
of "green":

| step       | declared task                               | local result on `a18cbaf`                |
| ---------- | ------------------------------------------- | ---------------------------------------- |
| type check | `deno task check`                           | exit 0                                   |
| unit tests | `deno task test` (`deno test --allow-read`) | 81 passed / 0 failed / 1 ignored, exit 0 |

Both were verified from a **cold cache** (`DENO_DIR` pointed at an empty dir), so a fresh runner
resolves `deno.land/std@0.224.0` and `npm:nostr-tools` from scratch.

Pins: `actions/checkout` v4 and `denoland/setup-deno` v2.0.5 by commit SHA, `deno-version: v2.9.0`
(the version this repo is developed against).

## What it deliberately does NOT gate

- **`deno task test:net`** (`deno test --allow-read --allow-net`): runs 82/82 locally, but the extra
  test in `tools/publish_readback_test.ts` talks to **real relays** — it is the live E2E lane, not a
  hermetic gate, and a relay outage would report as a repo failure. Kept out of CI on purpose.
- **`deno fmt --check`** and **`deno lint`**: both are **pre-existing red** on `main` (17
  unformatted files; 29 lint problems). They are not a gate here because making the suite red at the
  tip would hide real regressions. Fixing them is separate work.
