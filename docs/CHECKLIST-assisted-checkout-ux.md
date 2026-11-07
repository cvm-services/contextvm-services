# CHECKLIST — assisted checkout UX

Tracking for [`PLAN-assisted-checkout-ux.md`](PLAN-assisted-checkout-ux.md).

Legend: `[ ]` todo · `[x]` done · `[~]` needs operator.

## A. Card pause and handoff

- [x] A1. `awaiting_card` after Adyen iframes, before Kaufen.
- [x] A2. No 2fiat card/token read unless a facilitator explicitly selects it.
- [x] A3. Session handoff writes only 0600 transient data; not Session persisted.
- [x] A4. Handoff read + immediately deleted; never logged in plain form.
- [x] A5. `card-ready` is a distinct explicit Continue, not implicit on autofill.
- [x] A6. No buy before Continue; card can be entered manually in the VNC.
- [x] A7. Card iframe overlays remain redacted.

## B. Device saved card

- [x] B1. AES-GCM saved arbitrary PAN/expiry in browser IndexedDB.
- [x] B2. Card save/load/clear; last4-only display, CVV not saved.
- [x] B3. Autofill only on explicit click, then inspect + Continue.
- [x] B4. Nostr signer used for identity only; no Nostr events/relays/storage.
- [x] B5. 2fiat option remains but requires an explicit click.

## C. Phone opt-in, not removal

- [x] C1. Default `CVM_PHONE_AUTO=0` leaves country/number/SMS/code to human.
- [x] C2. `CVM_PHONE_AUTO=1` restores the existing automation.
- [x] C3. Existing US/DE and JMP/manual config and guards remain intact.
- [x] C4. No phone values appear in docs, state, or logs.

## D. UI / API / docs

- [x] D1. Session state includes awaiting_card; session GET exposes card readiness.
- [x] D2. LNURLP proxy endpoints for card + Continue with NIP-98/CSRF.
- [x] D3. Pretty facilitator card step implemented.
- [x] D4. Plan, checklist, runbook remain secret-free and in the public repo.
- [x] D5. No trust-root remote or published copy; update only the local service.

## E. Tests / demo

- [x] E1. Session API tests (54 baseline, plus card cases).
- [x] E2. LNURLP tests (23 baseline, plus card routes).
- [x] E3. Python state machine + syntax.
- [x] E4. Facilitator JS syntax.
- [~] E5. T14 restarted; card/Continue routes return 401 unauthenticated. x280 SSH is offline, so its restart/deploy is pending.
- [ ] E6. **Operator:** two small live demos (saved card, unsaved card).
- [ ] E7. **Operator:** record card/treasury deltas + redacted evidence.
