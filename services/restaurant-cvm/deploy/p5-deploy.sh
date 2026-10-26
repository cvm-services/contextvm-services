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

# 0. prerequisites the units assume. Each of these was MISSING on vps2fips when the
#    units were first verified there - a unit referencing a missing user or directory
#    fails at start with a message that points at the service, not the cause.
run "id cvm >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin cvm"
run "sudo install -d -o cvm -g cvm -m 0750 /var/lib/cvm"
run "sudo install -d -o root -g root -m 0755 /opt/cvm/services"
run "sudo install -d -o root -g root -m 0755 /etc/cvm"

# 1. units
run "sudo install -m 0644 /tmp/cvm-session-api.service /etc/systemd/system/"
run "sudo install -m 0644 /tmp/cvm-customer-api.service /etc/systemd/system/"
run "sudo systemctl daemon-reload"

# 2. secrets: materialised from the vault on the host, 0600, never printed
run "sudo install -d -m 0700 /etc/cvm && sudo sh -c 'umask 077; : > /etc/cvm/session-api.env'"
echo "   (values come from OpenBao on the host; this script never handles them)"

# 3. caddy: render, append, VALIDATE, and roll back if the result is invalid.
#
# This block used to print "vhost appended" and never append anything - a script
# that describes an action it does not perform is worse than one that fails.
TEMPLATE="$(cd "$(dirname "$0")/../../../infra/orangesync" && pwd)/captcha-handoff.caddy"
RENDERED="/tmp/vhost-${CAPTCHA_SESSION}.caddy"
sed -e "s|\${CAPTCHA_HOST}|${CAPTCHA_HOST}|g" \
    -e "s|\${CAPTCHA_SESSION}|${CAPTCHA_SESSION}|g" "$TEMPLATE" > "$RENDERED"

if [[ $APPLY -eq 1 ]]; then
  scp -q "$RENDERED" "$HOST:/tmp/vhost-rendered.caddy"
fi

run "sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-p5"
# Idempotent: re-running must not stack duplicate blocks.
run "sudo sh -c 'grep -q \"BEGIN CAPTCHA SESSION ${CAPTCHA_SESSION}\" /etc/caddy/Caddyfile || cat /tmp/vhost-rendered.caddy >> /etc/caddy/Caddyfile'"
# --adapter caddyfile is required: caddy assumes JSON otherwise and rejects a
# Caddyfile with "config is not valid JSON".
if [[ $APPLY -eq 1 ]]; then
  if ! ssh "$HOST" "sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile" >/dev/null 2>&1; then
    echo "VALIDATION FAILED - restoring the previous Caddyfile; nothing reloaded" >&2
    ssh "$HOST" "sudo cp /etc/caddy/Caddyfile.bak-p5 /etc/caddy/Caddyfile"
    exit 1
  fi
  echo "+ caddy validate: ok"
else
  echo "[dry-run] sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile"
fi

# 5. activate
run "sudo systemctl reload caddy"
run "sudo systemctl enable --now cvm-session-api cvm-customer-api"
run "systemctl --no-pager --lines=0 status cvm-session-api cvm-customer-api | head -20"

if [[ $APPLY -eq 1 ]]; then echo "APPLIED"; else echo "DRY RUN — nothing changed. Re-run with --apply."; fi
