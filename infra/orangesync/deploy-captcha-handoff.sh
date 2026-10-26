#!/usr/bin/env bash
# Deploy (or retire) the captcha-handoff Caddy vhost on the gateway host.
#
# WHY A SCRIPT AND NOT A HAND EDIT
#   The box is not the source of truth. The file lives in this repo and is
#   copied verbatim; a hand edit on the host is lost at the next deploy and
#   cannot be reviewed. Same rule as infra/orangesync/av-demo.caddy.
#
# The vhost is a tunnel target: it proxies to a loopback websockify port that an
# SSH reverse tunnel exposes. Nothing is exposed that the tunnel does not carry,
# so the public hostname and the tunnel have the same lifetime.
#
# Usage:
#   ./deploy-captcha-handoff.sh deploy [user@host]
#   ./deploy-captcha-handoff.sh retire [user@host]
set -euo pipefail
HOST="${2:-vps2fips}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${HERE}/captcha-handoff.caddy"
DEST="/etc/caddy/captcha-handoff.caddy"

case "${1:-}" in
  deploy)
    [ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 2; }
    : "${CAPTCHA_HOST:?set CAPTCHA_HOST (e.g. abc123.orangesync.tech) - never commit it}"
    case "$CAPTCHA_HOST" in *'${'*) echo "CAPTCHA_HOST was not substituted" >&2; exit 2;; esac
    TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
    sed "s|\${CAPTCHA_HOST}|${CAPTCHA_HOST}|" "$SRC" > "$TMP"
    scp -q "$TMP" "${HOST}:/tmp/captcha-handoff.caddy"
    ssh "$HOST" "sudo install -m 644 /tmp/captcha-handoff.caddy ${DEST} && rm -f /tmp/captcha-handoff.caddy"
    # A copied file is dead config until the main Caddyfile imports it — the
    # failure mode is a vhost that silently serves nothing (TLS handshake dies
    # because no cert was ever requested). Insert the import once, in place.
    ssh "$HOST" "sudo grep -q '^import captcha-handoff.caddy' /etc/caddy/Caddyfile || \
      printf '\n# Captcha handoff (ADR-0017) - managed file, see import target\nimport captcha-handoff.caddy\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null"
    ssh "$HOST" "sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1 && sudo systemctl reload caddy && echo RELOADED"
    ;;
  retire)
    # Remove the import line too, or Caddy fails to start once the file is gone.
    ssh "$HOST" "sudo sed -i '/^import captcha-handoff.caddy/d' /etc/caddy/Caddyfile; sudo rm -f ${DEST} && sudo systemctl reload caddy && echo RETIRED"
    ;;
  *)
    echo "usage: $0 deploy|retire [user@host]" >&2; exit 2 ;;
esac
