# PLAN — reproducible live smoke test (customer → facilitator → venue)

Status: **implemented; first live run recorded, re-run pending**.
Date: 2026-10-30. Owner: operator (x280 session API, T14 facilitator).

See [`CHECKLIST-live-smoke.md`](CHECKLIST-live-smoke.md) and
[`RUNBOOK-live-smoke.md`](RUNBOOK-live-smoke.md).

## 1. Goal

One reproducible operator procedure for the real flow:

```
customer pays a test order
  -> facilitator sees the paid order
  -> starts the assisted checkout (real VNC)
  -> solves the Turnstile
  -> verifies the configured country / number
  -> chooses WhatsApp manually
  -> receives the code, enters it, confirms
  -> presses "Venue confirmed" (or "Outcome unknown")
  -> card and treasury deltas are recorded
  -> session is closed and evidence is archived
```

The captcha and the WhatsApp code stay human. Accessibility automation is future
work; the runbook must remain usable without it.

## 2. Two tiers, never confused

| Tier | Command | Money | What it proves |
|---|---|---|---|
| Free regression | `test_e2e_two_phones.py` | none (demo token, `/__test__/venue/confirm`) | Customer PWA → paid order → facilitator list → viewer → simulated confirmation |
| Live smoke | `scripts/live-smoke.sh` + this runbook | real card charge (~€1.86) | The real LNURLP order, real session API, real venue checkout, real phone/WhatsApp gate |

The synthetic test is not evidence that a real payment or a real venue order
worked. The runbook labels the tiers explicitly.

## 3. The missing signal

The first successful live run used session `s_d_3396` and order
`o_07620770cb8f`. The human completed WhatsApp faster than the launcher's
captcha poll, so the launcher stayed `awaiting_human` while the card was charged
**$2.22** (`$17.10 → $14.88`).

Fix:

- `POST /sessions/:id/complete` with `{outcome: "confirmed"|"unknown",
  venue_ref?}`.
- The session API sets `completed` / `outcome_unknown`, records the venue
  reference, releases the controller and grants, and writes
  `/tmp/cvm-session-<id>.complete`.
- The launcher watches that file in every human wait loop and exits with the
  recorded verdict instead of holding for 20 minutes.
- The facilitator page has **Venue confirmed** (requires a reference) and
  **Outcome unknown** (no automatic refund).
- The CLI fallback:
  `scripts/live-smoke.sh complete SESSION=... REF=...` or `UNKNOWN=1`.

## 4. Test order

- Use a dedicated test order, not a production order.
- The cheapest venue item (Capri Sun, €1.50) keeps the card charge near
  **€1.86 / $2.22**.
- For the first re-run, the already-paid test order `o_026f787e026f` can be
  consumed once; afterwards create a new test order.
- Record the order id, session id, card delta, treasury delta and venue
  reference. One order per run.

## 5. Evidence and redaction

Artifacts live in `artifacts/live-smoke/` and are **not committed**.
The launcher redacts phone and card areas before every screenshot: it overlays
the phone input, card inputs and Adyen iframes with black boxes, takes the
screenshot, then removes the overlay. Never share an unredacted phone modal or
card form.

Evidence set:

- customer paid screen
- facilitator queue with the paid order
- VNC pre-captcha
- phone modal with the number redacted
- WhatsApp/code screen without the code
- final venue confirmation
- card/treasury before/after and the delta

## 6. Secrets

- The venue phone lives in OpenBao (`secret/fleet/venue-phone`) and is
  materialized by the private trust-root into a 0600 env.
- The session API token is in the same 0600 env.
- This public repo and the runbook contain **no secret values** and no phone
  numbers. The private trust-root is not pushed to any git remote.
- Screenshots are redacted before they leave the host.

## 7. Reference run

```
order:        o_07620770cb8f
session:      s_d_3396
phone source: OpenBao secret/fleet/venue-phone (DE, manual)
channel:      WhatsApp (human)
card:         $17.10 -> $14.88  (charge $2.22)
treasury:     46,252 sats (unchanged by the venue charge)
state gap:    launcher stayed awaiting_human; completion was manual
```

The first re-run should show `completed` with a venue reference and the card
delta in the report.

## 8. Out of scope

- Automating the Turnstile or the WhatsApp code.
- Automating 3-D Secure.
- Publishing the private trust-root or `hermes-fleet`.
- Rewriting already-public git history.
