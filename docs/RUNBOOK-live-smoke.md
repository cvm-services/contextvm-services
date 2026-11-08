# RUNBOOK — live smoke test (customer → facilitator → venue)

This is the **paid** end-to-end test. The free PWA regression is
`services/restaurant-cvm/tools/test_e2e_two_phones.py`; it simulates the venue
confirmation and must not be presented as proof of a real order.

## 0. Preconditions

- x280: `cvm-session-api.service` and `handoff-gateway.service` active.
- T14: `lnurlp.service` active; facilitator signed in with NIP-98.
- OpenBao: `secret/fleet/venue-phone` readable on x280; the private trust-root
  has materialized `CVM_PHONE`, `CVM_PHONE_COUNTRY`, `CVM_PHONE_MODE` into the
  0600 session API env.
- A paid **test order** exists. Use a dedicated order, not a production one.
  Cheapest item (Capri Sun, €1.50) keeps the card charge near €1.86 / $2.22.
- Card has enough balance; treasury is recorded before the run.
- The phone configured in OpenBao is the test number that can receive the
  WhatsApp code. Never print it.

## 1. Environment

```bash
# The env file is a systemd EnvironmentFile and is 0600/outside git. Do NOT
# `source` it: it contains a JSON value that bash would try to execute.
ENVF="$HOME/.hermes/cvm/session-api.env"
export CVM_SESSION_API="http://[fd36:3c0f:d6f:8029:ea50:958b:672e:bb0]:8791"
export CVM_SESSION_TOKEN="$(cat "$HOME/.hermes/cvm/session-token")"
export CVM_PUBLIC_BASE="$(sed -n 's/^CVM_PUBLIC_BASE=//p' "$ENVF")"
export CVM_PHONE="$(sed -n 's/^CVM_PHONE=//p' "$ENVF")"
export CVM_PHONE_COUNTRY="$(sed -n 's/^CVM_PHONE_COUNTRY=//p' "$ENVF")"
export CVM_PHONE_MODE="$(sed -n 's/^CVM_PHONE_MODE=//p' "$ENVF")"
```

Optional local helpers for the report:

```bash
export CVM_CARD_CMD='...'       # prints the 2fiat balance JSON
export CVM_TREASURY_CMD='...'   # prints {"balance_sats": ...}
```

## 2. Preflight

```bash
scripts/live-smoke.sh preflight
```

Expected: session API and facilitator page reachable; phone configured
(country/mode only, never the value); card/treasury snapshots written to
`artifacts/live-smoke/`.

## 3. Customer phase

1. Create the dedicated test order for the venue and the cheapest item.
2. Pay the invoice from the test wallet.
3. Wait until the order is `paid`.
4. Note the order id (`o_...`).

The current customer app (`/order-next/`) and the facilitator queue must both show `paid`; do not start
the checkout on an unpaid order.

## 4. Start the assisted checkout

```bash
scripts/live-smoke.sh session ORDER=o_...
```

Open the printed VNC URL, or the stable link:

```
{CVM_PUBLIC_BASE}/lnurlp/orders/<order>/start
```

Expected log lines: `handoff_ready`, `cart_badge`, `checkout`,
`advanced_to_payment`, `pay_frames`, `kaufen_clicked`, `phone_pre_captcha`.

## 5. Card phase: manual or explicit opt-in autofill

The launcher pauses at `awaiting_card`; it does not automatically submit the
purchase. Choose one path:

- **Manual entry (default):** type PAN, expiry and CVV into the venue card fields
  in the viewer. Nothing is sent to the session API or saved on the server.
- **Explicit autofill:** enter PAN, expiry and CVV in the facilitator's card panel
  and click **Autofill for this order**. These fields are removed from the DOM
  after the one-time handoff. The handoff is read and deleted by the launcher,
  never persisted in the session or logged.
- **Opt-in saved PAN/expiry:** tick **save this PAN and expiry on this device**
  before autofill. They are stored with AES-GCM encryption in browser IndexedDB.
  **CVV is never saved.** The Nostr signer proves your npub only; no card is put
  into a signer, event or relay.
- **Configured 2fiat card:** an explicit alternative to an arbitrary PAN. No
  backend card is read until this button is clicked. It never overrides a
  card-specific handoff you explicitly sent.

Then inspect the completed form and press **Continue to verification**.
Autofill alone is not permission to charge. If no Continue arrives, the launcher
expires with `card-not-provided`; no purchase was submitted. In either mode,
inspect before you charge.

## 6. Verification phase (phone automation is opt-in)

1. Solve the Turnstile in the VNC until the phone input is enabled.
2. Enter **your own country and number**, choose SMS or WhatsApp, and request
   the code. The default `CVM_PHONE_AUTO=0` does not type, select or request
   anything on your behalf.
3. Receive the code on your phone, enter it, and confirm at the venue.
4. Wait for the venue confirmation screen. `CVM_PHONE_AUTO=1` restores the
   existing country-select, E.164 typing, destination/request guards and JMP
   polling for an operator deliberately re-enabling automation.

If the launcher is still in `awaiting_human` after you finish, that is expected
until you press the completion button (next step).

**Repeat customer / no modal:** the venue may skip the phone modal once the
contact number is verified. The launcher then reads the confirmation page and
records the reference itself; do not treat the missing modal as a failure.

## 7. Complete the session

Preferred (facilitator page):

- Enter the venue reference and press **Venue confirmed**.
- If the outcome is genuinely unknown, press **Outcome unknown**. Do not refund
  automatically.

CLI fallback:

```bash
scripts/live-smoke.sh complete SESSION=s_... REF=TB-1234
# or
scripts/live-smoke.sh complete SESSION=s_... UNKNOWN=1
```

Expected: state `completed` (with `venue_ref`) or `outcome_unknown`; the
launcher exits instead of holding.

## 8. Verify

```bash
scripts/live-smoke.sh wait SESSION=s_... TIMEOUT=120
scripts/live-smoke.sh verify SESSION=s_...
scripts/live-smoke.sh collect
scripts/live-smoke.sh report
```

Checks:

- session state terminal and the reference recorded;
- card delta matches the venue charge;
- treasury delta matches the customer payment (not the card charge);
- journal contains `venue_confirmed` (or `venue_confirm_unknown`);
- the evidence directory contains the redacted screenshots.

Useful journal filter:

```bash
journalctl --user -u cvm-session-api.service --since "20 min ago" --no-pager \
  | grep -E 'handoff_ready|cart_badge|advanced_to_payment|pay_frames|kaufen_clicked|phone_pre_captcha|phone_ready_for_review|venue_confirmed|venue_confirm_unknown|ABORT'
```

## 9. Cleanup

```bash
scripts/live-smoke.sh cleanup SESSION=s_...
```

Then close the VNC tab. The order is consumed; do not reuse it.

## 10. Evidence

- `artifacts/live-smoke/report.json`
- customer paid screen
- facilitator queue
- VNC pre-captcha
- phone modal **with the number redacted**
- WhatsApp/code screen **without the code**
- final confirmation
- card/treasury before/after

The launcher overlays phone/card fields before every screenshot. Review the
images once more before sharing; never publish an unredacted modal or card form.

## 11. Failure modes

| Symptom | Meaning / action |
|---|---|
| `phone-not-configured` | OpenBao materialization missing; rerun the private installer |
| `wrong-destination` | Country/tail mismatch; no SMS was sent. Fix the config, new session |
| `phone-input-disabled` | Captcha not actually clear; solve again |
| `ABORT captcha-not-passed` | Hold elapsed; start a fresh session |
| No SMS on WhatsApp | Use the code from the app; the SMS rail is not involved |
| Phone modal absent | The venue may have placed the order already; the
  launcher now checks the success text/reference and waits for 3-D Secure |
| No venue reference | Press **Outcome unknown**; do not refund automatically |
| VNC "Target closed" | Reopen the stable `/start` link; it health-checks the session |
| `card-not-provided` | Inspect and press Continue: autofill is only a handoff, not a charging approval |
| Phone verification should be human | `CVM_PHONE_AUTO=0` is the default; `1` restores the preserved automation |

## 12. Reference run (2026-10-30)

```
order:        o_07620770cb8f
session:      s_d_3396
channel:      WhatsApp (human)
card:         $17.10 -> $14.88  (charge $2.22)
treasury:     46,252 sats
gap:          launcher stayed awaiting_human; the completion signal did not exist yet
```

Second run (order `o_026f787e026f`, session `s_a_59705`): the venue skipped the
phone modal, placed the order, charged `$2.22`, and showed reference `4`. The
launcher aborted `phone-modal-not-present`; the no-modal branch now accepts the
confirmation. Raw screenshots were deleted; the redacted crop is in
`artifacts/live-smoke/order-confirmed.png`.
