# Captcha handoff — facilitator UI contract

How the facilitator UI (PWA) embeds the live browser session without ever asking a
human to type a VNC credential.

## The record

`tools/captcha_handoff.sh` writes `session.json` (mode 0600) containing:

```json
{
  "display": ":77",
  "vnc_port": 5977,
  "web_port": 6077,
  "vnc_password": "…",          // empty when --no-password
  "password_required": false,
  "geometry": "1366x1200",
  "novnc_url": "https://<host>/vnc.html?autoconnect=1&resize=scale&password=…",
  "embed": { "kind": "iframe", "autoconnect": true, "resize": "scale",
             "width": "100%", "height": "100%" },
  "expires_at": "2026-10-26T12:30:00Z",
  "harness_pid": 1234
}
```

## The rule

**`src` of the iframe is `novnc_url` verbatim.** Do not rebuild it in the UI from
parts — a rebuilt URL drops the password and the operator is back to typing, which
is the friction this exists to remove.

```html
<iframe src="{{ session.novnc_url }}"
        allow="clipboard-read; clipboard-write"
        style="width:100%;height:100%;border:0"></iframe>
```

## Where the credential travels

Two supported postures:

| Posture | `--no-password` | Secret that gates access |
|---|---|---|
| Hostname-only (default) | yes | the unguessable vhost hostname |
| Password + hostname | no | hostname **and** the 8-char VNC password |

In both, the secret reaches the UI inside `novnc_url`, over the same authenticated
channel that delivers the session record. A human never sees or types it.

## Rules that keep this safe

1. **The URL is the credential.** Never log it, never render it in a chat, never
   commit it. It is written only to the 0600 `session.json`.
2. **Never commit the hostname.** The Caddy vhost is a template
   (`infra/orangesync/captcha-handoff.caddy`) and the deploy script substitutes
   `CAPTCHA_HOST` from the environment. This repo is public.
3. **VNC passwords are exactly 8 characters.** Classic VNC auth truncates longer
   values silently, so a 10-char password leaves the operator unable to log in
   while being told the wrong string.
4. **The session is ephemeral.** `expires_at` is authoritative: the browser process
   ends at the hold deadline and the tunnel/vhost are retired. The UI should treat
   an expired session as gone, not as an error to retry.
5. **Loopback only.** x11vnc and websockify bind 127.0.0.1; the public surface is a
   Caddy vhost proxying through an SSH reverse tunnel. Nothing exposes the display
   directly.

## Known gap

`--no-password` makes the hostname the sole secret. That is acceptable for a
throwaway session measured in minutes, but it means hostname rotation per session
is the real security control. Today the hostname is stable across sessions; rotating
it per session (and retiring the previous vhost) is the next hardening step.
