# PLAN — assisted checkout UX (card opt-in + phone opt-in)

Status: implemented (code and tests); live demo pending.
Date: 2026-11-07. Owner: operator (T14 + x280).

See [`CHECKLIST-assisted-checkout-ux.md`](CHECKLIST-assisted-checkout-ux.md)
and [`RUNBOOK-live-smoke.md`](RUNBOOK-live-smoke.md).

## 1. Goal

A demo-friendly, genuinely useful assisted checkout. The system navigates to the
real venue checkout and hands sensitive steps to the facilitator:

```
customer pays -> facilitator opens checkout
 -> Card (inspect, only then Continue)
 -> captcha -> facilitator's own phone/WhatsApp verification
 -> confirmation -> customer's confirmed screen
```

Nothing charges until the facilitator inspects the card form and presses
**Continue to verification**. Phone automation is **disabled by default, not
removed**. It can be restored with an explicit opt-in.

## 2. Decisions

### Card

- **Default:** manual entry into the remote checkout (VNC). Card data never
  reaches the session API or is saved centrally. No 2fiat token is read.
- **Opt-in (explicit action only):** one-time autofill of PAN/expiry/CVV for this
  order. A second explicit click is always required before charging.
- **Saved arbitrary PAN/expiry:** saved only on the facilitator's device,
  encrypted with AES-GCM/Web Crypto + IndexedDB. The Nostr signer provides the
  facilitator's npub; it is not a card vault and no Nostr event or relay is used.
- **CVV is never saved**. Ask for it on the order where it is used.
- The configured 2fiat card can also be selected explicitly, but is not used
  automatically. PAN/expiry are fetched by the launcher only at that point.
- The optional handoff for a one-time autofill is transient:
  - no card data in session storage, argv, env, logs, state, or the audit ledger;
  - 0600 file read once by the launcher and immediately deleted;
  - there is no way to read card data back through the API.
- Manual autofill still results in a data transfer for this one operation. The
  UI explains that distinction.

### Phone

- Default `CVM_PHONE_AUTO=0`: after the captcha, the facilitator enters their
  own country/number, chooses SMS or WhatsApp, requests the code, and enters it.
- `CVM_PHONE_AUTO=1` restores the existing country-select, E.164 typing,
  destination/request guards, optional JMP polling, and manual SMS mode.
- The OpenBao `secret/fleet/venue-phone` fields remain unchanged. Autoflow
  activation is explicitly opt-in per session.

### UI and evidence

- The facilitator card step is visible before the captcha/phone steps.
- Continue is enabled only after the card form is filled, whether manually or
  by opt-in autofill.
- Redact card iframes and phone numbers before screenshotting. Never save card
  numbers or CVV. Screenshots are local, not committed.
- The private trust root (OpenBao source of truth) has **no git remotes** and is
  never pushed/published. The frontend remains served locally from it.

## 3. Implementation

### Session API

- Add `awaiting_card` to the shared state set.
- Add `POST /sessions/:id/card` for optional one-time autofill:
  - accepts `source: manual` with PAN/expiry/CVV or `source: 2fiat`;
  - writes a 0600 handoff, does not persist it in the `Session`, and returns only
    `{ok: true}`;
  - launcher deletes it when read.
- Add `POST /sessions/:id/card-ready` for the explicit **Continue** action.
- Validate ownership and require an `awaiting_card` state so stale clicks cannot
  charge an already completed or captcha-stage checkout.

### Launcher

- Wait at `awaiting_card` after the Adyen frames are created.
- If no handoff, wait while the human types in the VNC.
- Read + immediately unlink the handoff if present; load the 2fiat card only if
  explicitly selected. Log only the source, never card fields.
- Fill the billing address, then continue only on `card-ready`.
- At the phone gate, choose the human or the existing opt-in automated path.

### Facilitator UI

- Card step with masked manual fields, saved-card load/clear, optional save,
  and a **Type in viewer instead** path.
- AES-GCM encrypted saved PAN/expiry in IndexedDB; CVV only in memory for one
  autofill.
- Explicit Continue after inspecting the viewer, then the captcha/phone screen.

### LNURLP server

- Authenticated `/internal/orders/<id>/card` and `/card-ready` routes proxy to the
  session API. They never log or store request bodies. Continue status is
  exposed on `GET /internal/orders/<id>/session`.

## 4. Tests

- Session API: route/auth/state tests, handoff not persisted/card never observable,
  cardinality of ready/continue.
- LNURLP: correct proxy path, internal auth, no raw body logging.
- Launcher: syntax/state machine tests, new manual card-source and opt-in flag
  parsed, manual no-J5fiat deferral, saved-card handoff deleted after read.
- JS: node syntax checks on vault + facilitator page.
- Live demo: cheapest item only, two variants (saved card and unsaved card),
  capture redacted evidence. No charge without operator action.

## 5. Demo acceptance

A non-technical facilitator can:

1. Click one paid order.
2. Decide whether to autofill from an explicitly opted-in saved card or enter
   the card in the viewer.
3. Inspect the form before anything is charged.
4. Press Continue once, solve captcha and their own phone verification.
5. Press Venue confirmed, see the reference, and show the customer's confirmed
   checkout.
