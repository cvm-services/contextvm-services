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
- [ ] B6. **Operator:** run the live smoke with a dedicated test order.
- [ ] B7. Record the venue reference and terminal state.
- [ ] B8. Record the card delta and treasury delta.
- [ ] B9. Attach the redacted screenshots.
- [ ] B10. Update the venue-phone checklist with the successful WhatsApp run.

## C. Redaction / secrets

- [x] C1. Screenshots redact phone, card inputs and Adyen iframes.
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
