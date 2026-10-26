# Decision: captcha-handoff credential posture for the facilitator dashboard

**Date:** 2026-10-26 · **Status:** proposed · **Context:** ADR-0017, `tools/CAPTCHA-HANDOFF.md`

## Recommendation

**Option 3 — per-session hostname rotation — with Option 2's URL-embedded password kept as a
second factor.**

The three options were framed as a convenience/security trade. That framing is wrong for a
dashboard integration: the credential is delivered *programmatically* through the session record
in all three cases, so **none of them costs the facilitator a keystroke**. There is no friction to
trade away. The choice is purely about how long the secret lives and what it protects.

| | Secret lifetime | Protects against | Fails when |
|---|---|---|---|
| 1. No password, static host | **forever** | nothing once leaked | a URL appears in a log, screenshot or referrer |
| 2. Password in URL | forever (host) + per-session (pw) | casual URL leak | 8-char VNC auth is weak; password leaks with the URL anyway |
| 3. Per-session hostname | **= session lifetime** | any replay after teardown | the session is live and the URL is live — by definition |

What is behind that URL is not a document. It is **a live browser holding a filled card form**, and
in the failing case a session that can spend the operator's money. A credential whose lifetime is
unbounded relative to the thing it protects is the wrong default.

Option 3 wins because it is the only one whose **access grant expires with the session**, and because
rotation is enforced by the code that already spawns sessions — not by operator discipline, which
is not a control.

> **CORRECTION (after consultant review, verified on the live host): the hostname is NOT a secret.**
> Our gateway issues a **per-hostname certificate**: the session host serves
> `CN = hsnxpcyykhgo.orangesync.tech`, a single SAN, out of 105 per-host certs on disk, with no
> wildcard. Let's Encrypt submits every issued certificate to **Certificate Transparency**, which is
> public. So the "unguessable" hostname is published *before the session starts* — it is an
> identifier, not a credential.
>
> This does not change the recommended option, but it destroys the reason I originally gave for it.
> Rotation buys **lifecycle and revocation**, not secrecy. Until the certificate posture changes,
> option 3 is not an access control and must not be described as one.

Keep the password as well (Option 2) once it is free: it is one query parameter on a URL the
dashboard already receives. It raises the cost of a screenshot or a shoulder-surf. It is *not* a
substitute for rotation.

### The destination is one step further

Both options still fail the same test: **nothing binds the session to a facilitator**. Anyone who
obtains the URL drives that browser. The correct end state is a **single-use ticket** scoped to
`(facilitator, order)`, validated at the edge, exchanged for the VNC connection and burned on
connect. Hostname rotation is the cheapest useful step *towards* that, not the endpoint. Recorded
here so this does not get mistaken for the finished design.

---

## Gap analysis

Ordered by what blocks what. "Today" means verified in this repo/filesystem, not assumed.

### P0 — no dashboard can exist without these

1. **Session API.** Today a bash script writes `session.json` on the operator host. A dashboard
   cannot read a file on another machine. Needs: `POST /sessions {order_id}` →
   `{session_id, novnc_url, state, expires_at}`; `GET /sessions/{id}`; `DELETE /sessions/{id}`.
   Without this there is no integration to speak of.
2. **Externally visible state machine.** The harness has no state a UI can read; state is inferred
   by a human reading log lines (`holding_for_human`, `kbd><retry`). Needs explicit states:
   `preparing → at_captcha → awaiting_human → solved → continuing → completed | failed(reason)`.
   The dashboard's entire value is showing which of these it is.
3. **Identity binding.** No binding between a session and the facilitator. Must be resolved before
   any real money flows through a dashboard: a leaked URL currently grants control of a card form.
4. **Per-session hostname rotation.** Today there is exactly one static vhost
   (`infra/orangesync/captcha-handoff.caddy` + `deploy-captcha-handoff.sh`). Needs spawn-time
   create and teardown-time retire, or Option 3 is not actually implemented.

### P1 — makes it usable rather than merely present

5. **Captcha view sized to the widget, not the desktop.** Measured cost of getting this wrong: a
   1366×1200 desktop on a phone makes each puzzle tile ~8px, which produced repeated failures and
   a **venue-side temporary lock**. `--clip` exists but the offsets are hardcoded from one run of
   one venue. Needs the harness to measure the widget's bounding box and clip to it.
6. **Iframe lifecycle UX.** Tunnel drop mid-captcha, the same session opened on two devices, and
   expiry while a human is mid-solve all have undefined behaviour today.
7. **Loud failures.** Silent today: the hold loop can spin while a human presses the button by
   hand (this caused a wrong-country SMS); a dropped tunnel renders a dead iframe with no signal;
   a venue lock appears only as a page inside the browser. Each needs a state, not a mystery.
8. **Order handoff.** After the captcha, the harness continues on its own; the dashboard learns
   nothing. Needs a transition event carrying the order id.

### P2 — hardening and honesty

9. **Audit trail**: which facilitator solved which captcha for which order, when. Needed for
   disputes and abuse, and it is trivial to add while the state machine is being built.
10. **Concurrency**: one harness process per order today. A queue/pool is required for more than
    one facilitator.
11. **Venue-lock detection and backoff.** We hit a real lock; there is no detection, no backoff, no
    budget on attempts.
12. **The destination guard is untested in its refusal path.** It is reasoned from logs, never fired
    in a live wrong-country run. Until it does, it is a claim.
13. **ADR-0017 status is still "proposed"** though the mechanism is merged and running.
14. **Test-runner split**: `services/fiat-cvm` mixes Deno and bun tests; a whole-directory run is
    not green.

### What NOT to build

- **Do not automate the captcha.** Measured twice: synthetic clicks are ignored and human-like
  clicks still produce an image puzzle. Attempting it turns an honest human step into an arms race
  we lose, and it is adversarial by design.
- **Do not build a custom VNC client.** noVNC is sufficient; the failures were credential handling
  and framing, not the viewer.
- **Do not store the session URL in dashboard localStorage.** It is a credential with a live
  browser behind it; keep it in memory, re-fetch by session id.
- **Do not reuse one browser profile across facilitators.** Isolation matters more than warm
  sessions; a shared profile links unrelated people in the venue's view.
- **Do not expose the display on a static hostname "just for convenience".** That is Option 1, and
  it is how a convenience becomes a permanent key.

---

## Incident that shapes the priorities

While building this, the SMS verification code was sent to **+49 8102 583253** — a real German
subscriber — because the venue's modal defaults to country DE and the country flip never ran (the
harness was still holding at the captcha). One unsolicited message to a stranger.

Consequence: the destination gate (`country == US`, 11 digits ending `8102583253`, else abort) is
P0-adjacent, and it is the reason "the harness must know the state and the dashboard must see it"
is ranked above convenience items. A silent hold loop produced an outward-facing harm.

---

## Consultant review (3 independent, cold, no prior context)

All three recommended **option 3**, and all three independently rejected the premise I had built it
on: that an unguessable hostname is a secret. Their verdicts converged past my analysis rather than
confirming it.

| Reviewer | Verdict on option 3 | The correction each made |
|---|---|---|
| Security / systems architecture | "Best lifecycle foundation, but still a bearer capability unless backed by authorization." | **Certificate Transparency publishes per-session hostnames.** A wildcard cert, provisioned independently of sessions, is required or the name is public. |
| Product / security architecture | "Rotation limits exposure; it does not identify the facilitator." | **Cropping is not a security boundary.** VNC exposes keyboard shortcuts, clipboard, navigation and browser state — not just the captcha widget. |
| Site reliability | "Lifecycle management, not identity authentication." | **One controller per session**; payment uncertainty is not failure; a route removal does not drop live sockets. |

### What they said that I had wrong or missing

1. **CT logs make per-session hostnames public.** Verified above. Fix: wildcard `*.orangesync.tech`
   issued once, not `on_demand_tls` per host. Hostname secrecy becomes defence-in-depth at best.
2. **Revoking a route does not disconnect live WebSockets.** Teardown must actively close sockets,
   not just remove routing. An `expires_at` in a JSON file enforces nothing.
3. **Authorize the WebSocket upgrade, not just the page.** Both HTTP and WS must be checked,
   or the transport is open even when the HTML is gated.
4. **One controller per session.** Two devices injecting clicks is a real, unhandled case; needs a
   server-enforced lease with an audited takeover, and human control revoked the moment automation
   resumes.
5. **Payment uncertainty ≠ failure.** A disconnect after submission is `PAYMENT_STATUS_UNKNOWN` and
   must be reconciled against the venue before any retry. Blind retry duplicates restaurant orders
   and double settlement. (Same class as the NWC double-pay guard, on the fiat side.)
6. **Never consume "the latest inbox message."** Correlate an SMS code to recipient, sender and
   request time, and reject stale ones — one JMP number serves every session.
7. **Respect a venue lockout; do not rotate identity to evade it.** A fresh browser does not clear an
   account-level restriction, and we already caused one lock plus one wrong-number SMS.
8. **`vnc.html` returning 200 proves almost nothing.** A readiness gate must check DNS/TLS, proxy
   route, WebSocket upgrade, VNC handshake and browser liveness before the URL is shown.

### Revised P0 (supersedes the P0 list above)

1. **Authenticated session broker** — facilitator identity + authorization bound to
   `(order, session)`, enforced on HTTP **and** the WebSocket upgrade, with live-socket revocation.
2. **Wildcard certificate** for session hostnames, issued independently — so hostnames are not
   broadcast via CT. (Verifiable: `openssl s_client … | openssl x509 -ext subjectAltName` must show
   `*.orangesync.tech`, not a single host.)
3. **State machine with `outcome_unknown`** and a **controller lease**.
4. **Destination + amount validation before submission**, for the same reason the phone gate exists:
   a wrong destination already sent a real SMS to a stranger.

Option 3 remains the recommendation. It is the right lifecycle foundation and the cheapest step
toward the real control — which is **authorization bound to the facilitator**, not a name.
