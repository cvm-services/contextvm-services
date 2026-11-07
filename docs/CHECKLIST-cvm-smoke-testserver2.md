# CHECKLIST — smoke test on testserver2

Tracking for [`PLAN-cvm-smoke-testserver2.md`](PLAN-cvm-smoke-testserver2.md).

Legend: `[ ]` todo · `[x]` done · `[~]` needs operator.

## A. Preparation

- [x] A1. testserver2 selected; x280 not modified while offline.
- [x] A2. Clone public main; no trust-root clone on testserver2.
- [x] A3. Chrome, x11vnc, Playwright venv; noVNC static assets present.
- [x] A4. Deno and Python compile checks pass.

## B. Isolated secrets and services

- [x] B1. Dedicated demo token generated; no production session token reused.
- [x] B2. Demo token stored only in 0600 env and OpenBao. No grants beyond
      venue-phone and demo-session on testserver2.
- [x] B3. Manual card source, phone automation disabled; no 2fiat lookup for manual.
- [x] B4. Isolated store/API/handoff ports and directories.
- [x] B5. User services running; gateway merges its own handoff only.
- [x] B6. Rollback file/credentials saved outside git.

## C. Routing / public surfaces

- [x] C1. T14 LNURLP points to testserver2 and uses the demo token.
- [x] C2. Caddy `/venue/view/*` points to loopback 8098 on testserver2.
- [x] C3. `/order`, `/console/` redirect, and `/api` unchanged.
- [x] C4. `/lnurlp/.../card`, `/card-ready`, `/session` return 401 without auth.
- [x] C5. Bare vnc.html and health routes verified.

## D. No-charge rehearsal

- [x] D1. Disposable session created; launcher reaches Adyen/card step.
- [x] D2. `awaiting_card` visible and Continue remains mandatory.
- [x] D3. No charge before operator Continue; cancel is idempotent.
- [x] D4. Screenshots contain no PAN, CVV or phone value.
- [x] D5. Device card storage stays off unless explicitly ticked.

## E. Operator live demo

- [ ] E1. One small dedicated test order marked paid by customer.
- [ ] E2. Facilitator types card manually (or explicitly opts into autofill).
- [ ] E3. Facilitator inspects → Continue → captcha → own phone/WhatsApp.
- [ ] E4. Venue confirmation + reference captured.
- [ ] E5. Card and treasury deltas recorded; the customer sees confirmed. Raw card fields and CVV stay redacted.
- [ ] E6. Reversible Caddy/session routing restoration agreed before restoring x280.
