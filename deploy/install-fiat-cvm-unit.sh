#!/usr/bin/env bash
# install-fiat-cvm-unit.sh — install + enable the 2fiat CVM systemd unit (ADR-0016).
#
# Run ONCE per host, as the operator (needs sudo for the unit file).
#
#   bash deploy/install-fiat-cvm-unit.sh
#
# The wallet token is NOT baked in here. The unit gets it one of two ways:
#   * TWO_FIAT_TOKEN via an EnvironmentFile materialised from OpenBao (preferred),
#     or
#   * the service reads OpenBao itself with this node's AppRole (fallback).
# Either way it is never in this script, the unit, or the repo.
#
# Requirements: sudo, deno at ~/.local/bin/deno, a fiat signing key at
# ~/.hermes/secrets/venues/fiat-cvm.nsec (VENUE=/NSEC=/HEX=/NPUB= lines).
set -euo pipefail

REPO="${CVM_REPO:-$HOME/repos/contextvm-services}"
KEY="${FIAT_KEY_FILE:-$HOME/.hermes/secrets/venues/fiat-cvm.nsec}"
UNIT=/etc/systemd/system/fiat-cvm.service
RELAYS="${FIAT_SERVER_RELAYS:-wss://relay2.orangesync.tech,wss://relay.primal.net}"
ALLOWLIST="${FIAT_PAY_ALLOWLIST:-}"

[ -r "$KEY" ] || { echo "missing key file: $KEY" >&2; exit 1; }

# An env file for the payment allowlist (not secret) and, when the operator
# materialises it, TWO_FIAT_TOKEN. Kept 0600 and outside the repo.
ENV_FILE="${FIAT_ENV_FILE:-/etc/cvm-fiat/config.env}"
sudo mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" > /dev/null <<EOF
# 2fiat CVM (ADR-0016). Add TWO_FIAT_TOKEN here ONLY if not using the OpenBao
# AppRole fallback. Never commit this file.
FIAT_PAY_ALLOWLIST=$ALLOWLIST
EOF
  sudo chmod 600 "$ENV_FILE"
fi

sudo tee "$UNIT" > /dev/null <<EOF
[Unit]
Description=2fiat CVM — fiat leg of the facilitator flow (ADR-0016)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=FIAT_SERVER_KEY_FILE=$KEY
Environment=FIAT_SERVER_RELAYS=$RELAYS
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$REPO
ExecStart=$REPO/services/fiat-cvm/run-fiat-server.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now fiat-cvm.service
echo "installed+enabled fiat-cvm.service"
echo "verify: systemctl status fiat-cvm --no-pager ; journalctl -u fiat-cvm -n 20"
