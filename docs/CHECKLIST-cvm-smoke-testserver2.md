# CHECKLIST — smoke test on testserver2

Tracking for [`PLAN-cvm-smoke-testserver2.md`](PLAN-cvm-smoke-testserver2.md).

Legend: `[ ]` todo · `[x]` done · `[~]` needs operator.

## A. Preparation

- [ ] A1. testserver2 selected; x280 not modified while offline.
- [ ] A2. Clone public main; no trust-root clone on testserver2.
- [ ] A3. Chrome, x11vnc, Playwright venv; noVNC static assets present.
- [ ] A4. Deno and Python compile checks pass.

## B. Isolated secrets and services

- [ ] B1. Dedicated demo token generated; no production session token reused.
- [ ] B2. Demo token stored only in 0600 env and OpenBao. No grants beyond
      venue-phone and demo-session on testserver2.
- [ ] B3. Manual card source, phone automation disabled; no 2fiat lookup for manual.
- [ ] B4. Isolated store/API/handoff ports and directories.
- [ ] B5. User services running; gateway merges its own handoff only.
- [ ] B6. Rollback file/credentials saved outside git.

## C. Routing / public surfaces

- [ ] C1. T14 LNURLP points to testserver2 and uses the demo token.
- [ ] C2. Caddy `/venue/view/*` points to loopback 8098 on testserver2.
- [ ] C3. `/order`, `/console/` redirect, and `/api` unchanged.
- [ ] C4. `/lnurlp/.../card`, `/card-ready`, `/session` return 401 without auth.
- [ ] C5. Bare vnc.html and health routes verified.

## D. No-charge rehearsal

- [ ] D1. Disposable session created; launcher reaches Adyen/card step.
- [ ] D2. `awaiting_card` visible and Continue remains mandatory.
- [ ] D3. No charge before operator Continue; cancel is idempotent.
- [ ] D4. Screenshots contain no PAN, CVV or phone value.
- [ ] D5. Device card storage stays off unless explicitly ticked.

## E. Operator live demo

- [ ] E1. One small dedicated test order marked paid by customer.
- [ ] E2. Facilitator types card manually (or explicitly opts into autofill).
- [ ] E3. Facilitator inspects → Continue → captcha → own phone/WhatsApp.
- [ ] E4. Venue confirmation + reference captured.
- [ ] E5. Card and treasury deltas recorded; customer sees confirmed.
- [ ] E6. Reversible Caddy/session routing restoration agreed before restoring x280.
