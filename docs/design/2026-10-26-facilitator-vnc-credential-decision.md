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

Option 3 wins because it is the only one where the secret **expires with the session**, and because
rotation is enforced by the code that already spawns sessions — not by operator discipline, which
is not a control.

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
