# PLAN — isolated live smoke test on testserver2 (x280 offline)

Status: isolated no-charge rehearsal passed; live order pending operator action.
Date: 2026-11-07. Owner: operator (T14 + testserver2).

See [`CHECKLIST-cvm-smoke-testserver2.md`](CHECKLIST-cvm-smoke-testserver2.md).
Related: [`PLAN-assisted-checkout-ux.md`](PLAN-assisted-checkout-ux.md).

## 1. Goal

Run the customer → facilitator → venue smoke flow while x280 is unreachable,
without cloning, publishing, or remotely hosting the OpenBao trust root and
without spending money accidentally.

Use **testserver2** as a temporary API/browser host:

- Deno, Xvfb, websockify, noVNC, sudo and running user-systemd are present.
- Chrome/x11vnc/Playwright are the only additions (isolated venv for Playwright).
- 5.1 GiB usable RAM is enough for one Chromium instance (never parallel tests).
- t440/cobrador are fallbacks, not concurrent hosts. Chrome was installed from the official stable package after the bundled Chromium crashed while initializing Adyen (two runs); the stable package works.

## 2. Isolation

- Public code only: clone `cvm-services/contextvm-services` `main` (assisted card
  checkout already consolidated). Do not copy `hermes-trust-root` there.
- Dedicated dirs under `~debian/cvm-smoke`: code, env, state, venv, logs.
- Session store at `/var/lib/cvm-smoke/sessions.json` (separate from `cvm-orders`).
- API owns port `8792`; noVNC gateway `8098`; VNC/websockify loopback only.
- A *new* demo session token, different from the production x280 token, stored
  in `0600` env files and OpenBao. No other production token, full-age private
  key, customer private key, or card token is copied to the test host.
- Configure `CVM_CARD_SOURCE=manual` and `CVM_PHONE_AUTO=0`.
- If OpenBao contact-phone materialization is needed, grant only
  `secret/fleet/venue-phone` to testserver2. No 2fiat token unless the operator
  explicitly opts in, and no full trust-root repo.

The private trust-root stays local on T14 with **no git remotes**. The pretty
facilitator UI stays served from T14 and uses the current LNURLP/session APIs.

## 3. Routing

- Change **only** the session-API base on T14 to testserver2 port 8792, with the
  new demo token.
- Change only the public `/venue/view/*` Caddy route to loopback port 8098 on
  testserver2 (the host of that Caddy).
- Keep customer order flow, `/api`, the LNURLP queue, and all payment invoice
  behavior unchanged. `/console/` still goes to the pretty facilitator page.
- Back up Caddyfile and T14 session env before the temporary routing change.
  Rollback means restoring x280 addresses and the prior token, never keeping
  a test token for production use.

## 4. Implementation checks

1. Clone current public main and create venv; compile Deno and Python.
2. Install Chrome, x11vnc, Playwright and verify a real headed instance under
   Xvfb + x11vnc + websockify (noVNC reachable through gateway).
3. Start session API and gateway with fresh stores/state.
4. Point T14 LNURLP to the isolated host; restart local LNURLP and Caddy.
5. Rehearse without money:
   - create a disposable smoke session for `o_smoke_rehearsal`;
   - open VNC (full query path), validate UI and phone/card redaction;
   - reach `awaiting_card`, then deliberately cancel; no Kaufen/Continue; verify
     no venue charge and `POST /sessions/:id/cancel` cleans the record.
6. Confirm the proxy routes and session-health behavior are working.
7. Operator-driven live demonstration only when explicitly requested:
   manual card entry or opt-in autofill, inspect → Continue → captcha →
   facilitator's phone/WhatsApp → venue reference. Keep CVV/service fields
   masked. No automated spend.

## 5. Acceptance

- `awaiting_card` reached on a real venue run; no authorization charged.
- VNC + Caddy WebSocket healthy; clear phone/card input fields.
- Saved-device PAN/expiry uses AES-GCM in IndexedDB; CVV never saved.
- `CVM_PHONE_AUTO=0` leaves phone verification to the facilitator; `1` restores
  the previous path. Nothing automatically submits without explicit Continue.
- No trust-root remote, trust-root repo on testserver2, duplicate customer order,
  or duplicate card charge.
- Only the demo secret is added and granted to testserver2; no other grants change.


## 6. Result of the no-charge rehearsal

- A disposable session reached **awaiting_card** on `testserver2` using the
  stable Chrome package.
- Public VNC responded **200** during the pause and **404** after the launcher
  was stopped. The session API session list is empty afterward.
- The Adyen form was displayed, with card fields masked; the reference crop
  contains no CVV, full PAN, or verification phone.
- No Continue was sent, no Kaufen click executed, and no 2fiat lookup re-used a
  card token. No charge was attempted.
- `deploy/testserver2/provision-smoke.py` and
  `deploy/testserver2/no-charge-rehearsal.py` are the reproducible public
  entry points. The latter takes `--order-id <string>` and generates a unique
  discardable ID by default.

## 7. Rollback after x280 returns

1. Restore `/etc/caddy/Caddyfile.pre-cvm-smoke-20261107` on testserver2 and
   reload Caddy.
2. Restore the T14 session env backup (outside git) recorded as
   `/tmp/opencode/lnurlp-env.pre-smoke.bak`, then restart `lnurlp.service`.
3. Stop the `cvm-smoke-*` user units and archive any desired evidence.
   Do not keep the temporary demo session token as a live production grant.
