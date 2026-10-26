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
OUT="${HOME}/reports/captcha-handoff/session.json"
DISP=":77"
VNCPORT=5977
WEBPORT=6077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --hold) HOLD="$2"; shift 2 ;;
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
Xvfb "$DISP" -screen 0 1366x1200x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2
kill -0 "$XVFB_PID" 2>/dev/null || { echo "FATAL: Xvfb failed to start on ${DISP}" >&2; exit 1; }

# --- VNC: random password per session ----------------------------------------
PASS="$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 10)"
x11vnc -display "$DISP" -rfbport "$VNCPORT" -localhost -passwd "$PASS" \
       -forever -shared -noxdamage -repeat >/dev/null 2>&1 &
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
  "${HERE}/venue_phone_test.py" --country US --hold "$HOLD" \
  >"${HOME}/reports/captcha-handoff/harness.log" 2>&1 &
HARNESS_PID=$!

cat > "$OUT" <<JSON
{
  "display": "${DISP}",
  "vnc_port": ${VNCPORT},
  "web_port": ${WEBPORT},
  "vnc_password": "${PASS}",
  "harness_pid": ${HARNESS_PID},
  "xvfb_pid": ${XVFB_PID},
  "vnc_pid": ${VNC_PID},
  "ws_pid": ${WS_PID},
  "hold_seconds": ${HOLD},
  "novnc_path": "vnc.html?autoconnect=1&resize=scale&reconnect=1",
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
