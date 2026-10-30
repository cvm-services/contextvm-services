# CHECKLIST — live smoke test

Tracking for [`PLAN-live-smoke.md`](PLAN-live-smoke.md) and
[`RUNBOOK-live-smoke.md`](RUNBOOK-live-smoke.md).

Legend: `[ ]` todo · `[x]` done · `[~]` needs operator.

## A. Completion signal

- [x] A1. `POST /sessions/:id/complete` with `outcome` and optional `venue_ref`.
- [x] A2. `completed` / `outcome_unknown` are terminal, release the controller
      and grants, and are idempotent.
- [x] A3. The API writes `/tmp/cvm-session-<id>.complete`.
- [x] A4. The launcher checks the signal in the captcha hold, phone
      confirmation, manual-code and post-confirm/3DS waits.
- [x] A5. Unit tests for confirmed, unknown, wrong facilitator and expired.
- [x] A6. Facilitator page: **Venue confirmed** and **Outcome unknown**.
- [x] A7. CLI fallback: `scripts/live-smoke.sh complete`.

## B. Reproducible run

- [x] B1. `docs/RUNBOOK-live-smoke.md` with preflight, customer, facilitator,
      verification and cleanup phases.
- [x] B2. `scripts/live-smoke.sh` with `preflight`, `session`, `wait`,
      `complete`, `verify`, `collect`, `cleanup`, `report`.
- [x] B3. `make live-smoke` target.
- [x] B4. Artifacts directory ignored by git.
- [x] B5. Free tier clearly separated (`test_e2e_two_phones.py`).
- [x] B6. **Operator:** two dedicated test orders consumed (first via WhatsApp,
      second without a phone modal).
- [~] B7. Venue reference `4` observed on the second confirmation; the order
      ledger ref is pending the facilitator **Venue confirmed** button. The
      launcher session is `failed` from the old false-negative path.
- [x] B8. Card `$17.10 -> $12.66` (two charges of `$2.22`); treasury unchanged
      by the venue charges.
- [x] B9. Redacted confirmation crop saved in `artifacts/live-smoke/`
      (`order-confirmed.png`); raw screenshots were deleted.
- [x] B10. Venue-phone checklist updated (WhatsApp run, card delta, ref gap).

## C. Redaction / secrets

- [x] C0. The no-modal success branch accepts a placed order instead of
      aborting; a charged order is never marked failed for a missing gate.

- [x] C1. Screenshots redact phone, card inputs, Adyen iframes **and
      text-rendered phone numbers** (the confirmation page prints the contact
      phone as text).
- [x] C2. No phone number, token or card value in this repo or the runbook.
- [x] C3. Phone and session token come from the private trust-root / 0600 env.
- [x] C4. Artifacts are not committed.
- [ ] C5. Review the collected screenshots before sharing.

## D. Follow-ups (separate work)

- [ ] D1. Remove the trust-root git remote and delete the private snapshot from
      third-party hosting (requires `delete_repo` scope or the web UI).
- [ ] D2. Scrub and publish the `cvm-services` repos, temporarily private during
      the scrub.
- [ ] D3. Accessibility automation for the WhatsApp step (future).
