#!/usr/bin/env bash
# run-fiat-server.sh — boot the 2fiat CVM server (ADR-0016).
#
# The wallet token is NEVER on a command line. Resolution order:
#   1. TWO_FIAT_TOKEN in the environment — how the systemd unit receives it
#      (materialised from OpenBao into an EnvironmentFile, ADR-020)
#   2. otherwise secret.ts reads OpenBao directly with this node's AppRole
#
# Env:
#   FIAT_SERVER_KEY_FILE   signing key (default: fiat-cvm.nsec in the venue key dir)
#   FIAT_SERVER_RELAYS     comma-separated wss:// URLs
#   FIAT_PAY_ALLOWLIST     comma-separated pubkeys allowed to call `pay`
set -euo pipefail

cd "$(dirname "$0")/../.."

# A systemd SYSTEM unit does not set $HOME, and the AppRole fallback needs it to
# locate ~/.hermes/openbao/env (secret.ts reads $HOME). Derive it from the
# account database rather than trusting the environment.
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$HOME" ] || { echo "[run-fiat-server] cannot determine HOME" >&2; exit 1; }

KEY_FILE="${FIAT_SERVER_KEY_FILE:-$HOME/.hermes/secrets/venues/fiat-cvm.nsec}"
RELAYS="${FIAT_SERVER_RELAYS:-wss://relay2.orangesync.tech,wss://relay.primal.net}"
ALLOWLIST="${FIAT_PAY_ALLOWLIST:-}"

if [[ ! -r "$KEY_FILE" ]]; then
  echo "[run-fiat-server] key file not readable: $KEY_FILE" >&2
  exit 1
fi

# Extract HEX=<64 hex> from the VENUE=... NSEC=... HEX=... NPUB=... line.
HEX=$(grep -o 'HEX=[0-9a-f]\{64\}' "$KEY_FILE" | head -1 | cut -d= -f2)
if [[ -z "$HEX" ]]; then
  echo "[run-fiat-server] no HEX= field in $KEY_FILE" >&2
  exit 1
fi

export SERVER_HEX="$HEX"
export FIAT_SERVER_RELAYS="$RELAYS"
export FIAT_PAY_ALLOWLIST="$ALLOWLIST"

exec ~/.local/bin/deno run \
  --allow-net \
  --allow-read="$PWD/services","$HOME/.hermes/openbao" \
  --allow-env=SERVER_HEX,FIAT_SERVER_RELAYS,FIAT_PAY_ALLOWLIST,TWO_FIAT_TOKEN,OPENBAO_ADDR,OPENBAO_ROLE_ID_FILE,OPENBAO_SECRET_ID_FILE,HOME \
  services/fiat-cvm/main.ts
