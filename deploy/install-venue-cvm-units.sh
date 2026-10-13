#!/usr/bin/env bash
# install-venue-cvm-units.sh — install + enable the venue CVM systemd units.
#
# Why: the venue servers were hand-run on cobrador and died silently in the
# 2026-10 fleet migration to x280. This installer makes the hosting reproducible
# (Felix's rule: default-branch IaC, no host hand-edits). Run ONCE per host:
#
#   bash deploy/install-venue-cvm-units.sh            # all venues with key files
#   bash deploy/install-venue-cvm-units.sh three-buddies-berlin la-mama-berlin
#
# Requirements: sudo, deno at ~/.local/bin/deno, venue key files at
# ~/.hermes/secrets/venues/<slug>.nsec (VENUE=… NSEC=… HEX=… NPUB=… lines),
# repo checked out at ~/repos/contextvm-services (override: CVM_REPO).
#
# NOTE the units call services/restaurant-cvm/run-venue-server.sh, NOT deno
# directly: the wrapper extracts SERVER_HEX from the key file so the secret
# never appears in `systemctl cat` output or a unit file.
set -euo pipefail

REPO="${CVM_REPO:-$HOME/repos/contextvm-services}"
KEYDIR="${VENUE_KEY_DIR:-$HOME/.hermes/secrets/venues}"
UNIT_DIR=/etc/systemd/system

if [ $# -gt 0 ]; then VENUES="$*"; else VENUES="$(ls "$KEYDIR"/*.nsec 2>/dev/null | xargs -n1 basename | sed 's/\.nsec$//' | tr '\n' ' ')"; fi
[ -n "$VENUES" ] || { echo "no venue key files in $KEYDIR" >&2; exit 1; }

for V in $VENUES; do
  KEY="$KEYDIR/$V.nsec"
  [ -r "$KEY" ] || { echo "SKIP $V: no key file"; continue; }
  sudo tee "$UNIT_DIR/venue-cvm-server-$V.service" > /dev/null <<EOF
[Unit]
Description=Venue CVM server: $V
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=VENUE_SERVER_KEY_FILE=$KEY
Environment=VENUE_SERVER_VENUES=$V
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$REPO
ExecStart=$REPO/services/restaurant-cvm/run-venue-server.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "venue-cvm-server-$V.service"
  echo "installed+enabled venue-cvm-server-$V.service"
done

echo
echo "verify: systemctl list-units 'venue-cvm-server-*' --no-pager"
echo "probe:  docs/e2e-steglitz-runbook.md §live-probe (e2e_client.ts per venue)"
