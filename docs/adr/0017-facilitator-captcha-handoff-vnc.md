# ADR-0017: Facilitator captcha handoff via VNC-in-PWA

- **Status:** proposed (awaiting operator approval) → implemented (session manager; see below)
- **Tier:** docs/medium
- **Date:** 2026-10-20
- **Depends on:** ADR-0012 (escalation DM, replies-as-input), ADR-0013 (card-value custody),
  ADR-0016 (2fiat CVM service), the R3b measurement in
  `docs/RALPH-LOOP-finish-sats-ordering.md` (hCaptcha visual challenge at the venue
  phone gate).

## Context

The live venue checkout (FoodAmigos storefront, Three Buddies Steglitz) gates every
guest card order behind a human-verification step: an hCaptcha-branded widget
("Ich bin ein Mensch") served from Cloudflare Turnstile infrastructure, followed by
phone-number verification. Measured on 2026-10-20:

- A synthetic click inside the measured checkbox bounds is **silently ignored**.
- A human-like mouse-travel click **triggers the widget**, which then issues a
  **visual challenge** ("Finden Sie das eierlegende Tier" — an image puzzle with
  refresh/skip controls).
- Until the captcha passes, the phone control (`react-phone-number-input`) keeps
  BOTH the country `<select>` and the number input `disabled` — the automation
  cannot even set the phone number.
- Everything else in the chain is measured and automatable: cart, contact, Adyen
  secured-field fill, billing address, +1 country selection, number entry, SMS
  selection, code request, JMP inbox poll.

So the verdict for the venue phone gate is `SPEND: human_required`. The question
this ADR answers is *where the required human sits*: navigating the whole checkout
(`deep_link_human`), or seeing exactly one widget.

## Decision

When `restaurant-cvm` reaches a captcha challenge during a venue checkout it
**opens an ephemeral interactive session for the facilitator** and hands it over
through the nostr client:

1. **The CVM drives the checkout** with the proven harness, up to the captcha.
2. **At the challenge** it starts an ephemeral session: a persistent Xvfb display
   with x11vnc, bridged to the web by websockify, fronted by noVNC inside the
   existing customer PWA domain (`cvm-pwa.orangesync.tech`), behind the PWA's
   session auth and a one-time, order-scoped path token.
3. **It escalates via the ADR-0012 DM pattern**: the facilitator receives
   "Order <id> needs a human at the checkout — open <link>, solve the one
   puzzle, close it. Everything else is done." The DM carries no card values,
   no session cookies, no order secrets — only the one-time link.
4. **The facilitator interacts with the real widget in their nostr client's
   embedded view** (noVNC canvas in the PWA): clicks the checkbox, solves the
   image puzzle with real clicks/hover.
5. **The CVM polls for the pass** (turnstile token present, or
   `PhoneInput--disabled` gone from the wrapper class), then completes the rest
   of the chain autonomously: +1 selection, JMP number entry, SMS option,
   "Code senden", code retrieval from the JMP inbox, code entry, order submit.
6. **The session is torn down immediately** after the pass (or a timeout):
   Xvfb display killed, x11vnc and websockify stopped, link invalidated.
   Nothing persists between orders.

## Why VNC-in-PWA rather than the alternatives

- **Screenshot relay** (DM the puzzle image, reply with tile numbers): rejected
  because image challenges sometimes require hover/zoom and multi-click
  sequences, and the reply loop is slow and error-prone for a hand-held device.
  The operator explicitly preferred interactive control.
- **Facilitator navigates the checkout themselves** (`deep_link_human`): works
  today but exposes the whole checkout — including the Adyen card fields — to
  manual handling, and costs the facilitator minutes per order.
- **Programmatic puzzle-solving**: adversarial automation; out of scope on
  principle and operationally fragile.

VNC-in-PWA narrows the human's exposure to the single widget: the Adyen fields
are filled by the automation before the gate fires, so the facilitator never
sees card values. Card material never crosses the VNC surface in either
direction.

## Security and custody properties

- **No card values on the relay.** Card details are fetched JIT (ADR-0013),
  typed into Adyen's secured fields before the gate, and are not visible in
  the VNC session the facilitator sees (the widget overlay covers the form;
  the session is read-only-pointer unless the facilitator scrolls, and the
  teardown happens before any payment submit).
- **One-time, order-scoped link.** The websockify path token is unguessable,
  bound to the order id, invalidated on pass/timeout/teardown.
- **The human is the facilitator of record for their own customer's order.**
  This is remote assistance with the facilitator's own hands on the widget —
  not a third-party captcha-solving service. The ADR states this deliberately:
  the handoff exists to keep a human in the loop, not to remove one.
- **JMP number custody is unchanged**: the number lives in the fleet vault,
  the inbox is polled read-only; the SMS code is single-use and consumed in-page.

## State machine additions

`placing → captcha_pending → captcha_solved → phone_unlocked → code_sent →
order_placed` — with `captcha_pending` carrying the session id + link, and
`captcha_solved` set by the pass detector (not by the facilitator's claim).

## Session lifecycle (the implemented manager)

`services/restaurant-cvm/tools/captcha_session.py`:

- `spawn(order_id)` → allocates `:NN` display, Xvfb 1366x1200, x11vnc on a
  localhost-only high port with a random session password, websockify on a
  second localhost-only high port; writes a one-time token; returns the
  session record. Ports are `127.0.0.1`-bound; the PWA's reverse proxy
  (Caddy) fronts the websockify port with the path token as auth.
- `health(session)` → process liveness + ages.
- `teardown(session)` → kills x11vnc, websockify, Xvfb in order; removes the
  token; idempotent.
- Tests (`captcha_session_test.py`) cover: spawn produces live processes,
  teardown kills them all and is idempotent, stale sessions are reaped,
  tokens are unguessable, and no port listens after teardown.

## Open questions (to measure on the first live handoff)

1. Does the venue re-challenge every order, or does a passed session persist
   (cookie-scoped) for later orders? If it persists, the handoff is once per
   facilitator account, not per order.
2. Does the challenge always fire at the same point (after buy click), or can
   it appear earlier on some flows?
3. The first live pass also proves the SMS arrival in the JMP inbox and the
   code entry end to end.

## Consequences

- The facilitator's per-order human cost drops to "solve one image puzzle in
  the nostr client" (~10–20 seconds) from "navigate the whole checkout".
- The VNC bridge is per-order ephemeral and single-purpose; it is NOT a general
  remote-desktop feature and must never front the payment submit step.
- If a future venue uses no captcha, the flow degrades gracefully: no session,
  no DM, straight to the phone step.