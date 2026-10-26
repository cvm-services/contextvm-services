#!/usr/bin/env bash
# Captcha handoff session (ADR-0017): drive the venue checkout to the captcha,
# then expose THAT SAME live browser to a human over noVNC.
#
# Why this shape
#   The captcha token is bound to the browser instance. Re-driving from a fresh
#   context after a human solves it throws the token away, so the harness process
#   must stay alive and hold the page while the human works. This script starts
#   the display, the harness, the VNC server and the web bridge, and prints the
#   one connection record the PWA/Caddy front needs.
#
# Security
#   x11vnc and websockify listen on 127.0.0.1 ONLY. The public surface is a Caddy
#   vhost with an unguessable hostname; VNC still requires the per-session
#   password. Both are printed once, never written to a log.
#
# Usage:  ./captcha_handoff.sh [--hold SECONDS] [--out /path/session.json]
set -uo pipefail

HOLD=900
# Desktop geometry by default: the venue's checkout is NOT usable at phone width.
# Measured 2026-10-25: at 430x932 the storefront renders a different layout and
# the proven controls ("Menue Anzeigen", the Adyen frames, "Kaufen fuer") are not
# visible, so the harness cannot reach the captcha at all. The phone gets a
# SCALED view of a desktop session instead (noVNC resize=scale + pinch zoom).
# Override only for a venue whose flow is known to work at that size.
GEOM="1366x1200"
CLIP=""   # e.g. 560x640+340+400: stream ONLY this region (captcha column)
NOPW=0    # 1 = no VNC password; the unguessable hostname is then the only gate
# Public base for the embed URL, e.g. https://abc123.orangesync.tech . Provided by
# the deploy step (the hostname is a per-session credential and is never committed).
PUBLIC_BASE=""
OUT="${HOME}/reports/captcha-handoff/session.json"
DISP=":77"
VNCPORT=5977
WEBPORT=6077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --hold) HOLD="$2"; shift 2 ;;
    --geometry) GEOM="$2"; shift 2 ;;
    --clip)     CLIP="$2"; shift 2 ;;
    --no-password) NOPW=1; shift ;;
    --public-base) PUBLIC_BASE="$2"; shift 2 ;;
    --out)  OUT="$2";  shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$OUT")" "${HOME}/reports/captcha-handoff"
chmod 700 "$(dirname "$OUT")"

cleanup() {
  for p in "${WS_PID:-}" "${VNC_PID:-}" "${XVFB_PID:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

# --- display ------------------------------------------------------------------
pkill -f "Xvfb ${DISP} " 2>/dev/null
sleep 1
# +extension RANDR lets x11vnc resize the framebuffer to whatever the client
# asks for, so a phone that is not exactly GEOM still gets a fitting view.
Xvfb "$DISP" -screen 0 "${GEOM}x24" +extension RANDR -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2
kill -0 "$XVFB_PID" 2>/dev/null || { echo "FATAL: Xvfb failed to start on ${DISP}" >&2; exit 1; }

# --- VNC: random password per session ----------------------------------------
# VNC classic auth is 8 characters; x11vnc truncates anything longer without
# warning, so a 10-char password leaves the operator unable to log in.
CLIP_ARGS=()
[ -n "$CLIP" ] && CLIP_ARGS=(-clip "$CLIP")

PASS="$(head -c 8 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)"
# VNC auth is a real source of friction on a phone: classic auth takes exactly 8
# characters (longer is truncated silently) and noVNC's ?password= handling is
# unreliable on mobile browsers. With --no-password the session is still gated by
# an unguessable hostname, a loopback-only listener and a short lifetime - so the
# hostname becomes the credential and must be treated as one (never committed).
AUTH_ARGS=(-passwd "$PASS")
[ "$NOPW" = "1" ] && AUTH_ARGS=(-nopw)
x11vnc -display "$DISP" -rfbport "$VNCPORT" -localhost "${AUTH_ARGS[@]}" \
       -forever -shared -noxdamage -repeat "${CLIP_ARGS[@]}" >/dev/null 2>&1 &
VNC_PID=$!
sleep 2
kill -0 "$VNC_PID" 2>/dev/null || { echo "FATAL: x11vnc failed" >&2; exit 1; }

# --- web bridge: noVNC over websockets, loopback only ------------------------
websockify --web /usr/share/novnc "127.0.0.1:${WEBPORT}" "127.0.0.1:${VNCPORT}" \
           >/dev/null 2>&1 &
WS_PID=$!
sleep 2
kill -0 "$WS_PID" 2>/dev/null || { echo "FATAL: websockify failed" >&2; exit 1; }

# --- the harness, holding at the captcha in the SAME browser -----------------
DISPLAY="$DISP" "${HOME}/.cache/pw-venv/bin/python" \
  "${HERE}/venue_phone_test.py" --country US --hold "$HOLD" --viewport "$GEOM" \
  >"${HOME}/reports/captcha-handoff/harness.log" 2>&1 &
HARNESS_PID=$!

# The facilitator UI must never make a human type a VNC credential. It receives a
# complete URL and drops it into an iframe. The password (when enabled) rides in
# the query string of THAT url, which is why the URL is treated as a secret and
# written only into the 0600 session record.
QS="autoconnect=1&resize=scale"
if [ "$NOPW" != "1" ]; then QS="${QS}&password=${PASS}"; fi
NOVNC_URL=""
if [ -n "$PUBLIC_BASE" ]; then NOVNC_URL="${PUBLIC_BASE%/}/vnc.html?${QS}"; else NOVNC_URL="vnc.html?${QS}"; fi
EXPIRES="$(date -u -d "+${HOLD} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"

cat > "$OUT" <<JSON
{
  "display": "${DISP}",
  "vnc_port": ${VNCPORT},
  "web_port": ${WEBPORT},
  "vnc_password": "$([ "$NOPW" = "1" ] && echo "" || echo "$PASS")",
  "password_required": $([ "$NOPW" = "1" ] && echo false || echo true),
  "harness_pid": ${HARNESS_PID},
  "xvfb_pid": ${XVFB_PID},
  "vnc_pid": ${VNC_PID},
  "ws_pid": ${WS_PID},
  "hold_seconds": ${HOLD},
  "geometry": "${GEOM}",
  "novnc_path": "${QS}",
  "novnc_url": "${NOVNC_URL}",
  "embed": {"kind": "iframe", "autoconnect": true, "resize": "scale",
            "width": "100%", "height": "100%",
            "note": "src = novnc_url verbatim; do not rebuild it in the UI, or the credential is lost"},
  "expires_at": "${EXPIRES}",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
chmod 600 "$OUT"

echo "READY"
echo "harness_log=${HOME}/reports/captcha-handoff/harness.log"
echo "session=${OUT}"

# Keep the session alive. Without this the script exits immediately, the EXIT
# trap fires, and every listener is torn down before a human can connect.
wait "$HARNESS_PID"
