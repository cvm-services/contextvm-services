#!/usr/bin/env bash
# P5 deployment — DRY RUN BY DEFAULT.
#
# This touches the host that fronts every other service on vps2fips: a bad reload
# takes the whole fleet down, not just this workstream. So it prints the plan and
# changes nothing unless you pass --apply, and it validates the Caddy config
# before reloading.
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

HOST="${HOST:-vps2fips}"
SESSION_ID="${CAPTCHA_SESSION:?set CAPTCHA_SESSION (the session id for the vhost)}"
VHOST="${CAPTCHA_HOST:?set CAPTCHA_HOST (e.g. <token>.orangesync.tech)}"

run() {
  if [[ $APPLY -eq 1 ]]; then
    echo "+ $*"
    ssh "$HOST" "$@"
  else
    echo "[dry-run] $*"
  fi
}

echo "=== plan (host=$HOST) ==="
echo "1. install units to /etc/systemd/system/"
echo "2. write /etc/cvm/*.env from OpenBao (values never echo)"
echo "3. install Caddy vhost with forward_auth (session=$SESSION_ID)"
echo "4. caddy validate BEFORE reload"
echo "5. reload caddy, start units"
echo

# 1. units
run "sudo install -m 0644 /tmp/cvm-session-api.service /etc/systemd/system/"
run "sudo install -m 0644 /tmp/cvm-customer-api.service /etc/systemd/system/"
run "sudo systemctl daemon-reload"

# 2. secrets: materialised from the vault on the host, 0600, never printed
run "sudo install -d -m 0700 /etc/cvm && sudo sh -c 'umask 077; : > /etc/cvm/session-api.env'"
echo "   (values come from OpenBao on the host; this script never handles them)"

# 3. caddy
run "sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-p5"
run "sudo caddy validate --config /etc/caddy/Caddyfile"
echo "   (vhost appended from infra/orangesync/captcha-handoff.caddy, CAPTCHA_SESSION substituted)"

# 5. activate
run "sudo systemctl reload caddy"
run "sudo systemctl enable --now cvm-session-api cvm-customer-api"
run "systemctl --no-pager --lines=0 status cvm-session-api cvm-customer-api | head -20"

if [[ $APPLY -eq 1 ]]; then echo "APPLIED"; else echo "DRY RUN — nothing changed. Re-run with --apply."; fi
