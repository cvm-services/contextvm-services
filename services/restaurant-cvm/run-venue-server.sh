#!/bin/bash
# run-venue-server.sh — boot the Stage-1 venue CVM server as the announced
# doppelt-kaese-berlin identity over the real relay set.
#
# The secret NEVER appears on a command line: it is read from the venue key
# file into SERVER_HEX inside this process only, and the file itself is 0600
# under ~/.hermes/secrets/venues/ (outside the repo).
#
# Env:
#   VENUE_SERVER_KEY_FILE  path to the key file (default: doppelt-kaese-berlin.nsec)
#   VENUE_SERVER_RELAYS    comma-separated wss:// URLs
#   VENUE_SERVER_VENUES    comma-separated venue slugs this instance serves
#                          (absent/empty => ALL venues)
set -euo pipefail

cd "$(dirname "$0")/../.."

KEY_FILE="${VENUE_SERVER_KEY_FILE:-$HOME/.hermes/secrets/venues/doppelt-kaese-berlin.nsec}"
RELAYS="${VENUE_SERVER_RELAYS:-wss://relay2.orangesync.tech,wss://relay.primal.net}"
VENUES="${VENUE_SERVER_VENUES:-}"

if [[ ! -r "$KEY_FILE" ]]; then
  echo "[run-venue-server] key file not readable: $KEY_FILE" >&2
  exit 1
fi

# Extract HEX=<64 hex> from the VENUE=... NSEC=... HEX=... NPUB=... line.
HEX=$(grep -o 'HEX=[0-9a-f]\{64\}' "$KEY_FILE" | head -1 | cut -d= -f2)
if [[ -z "$HEX" ]]; then
  echo "[run-venue-server] no HEX= field in $KEY_FILE" >&2
  exit 1
fi

export SERVER_HEX="$HEX"
# Never let the secret leak into a crash dump or environment of children.
export VENUE_SERVER_RELAYS="$RELAYS"
export VENUE_SERVER_VENUES="$VENUES"

exec ~/.local/bin/deno run \
  --allow-net \
  --allow-read="$PWD/venues","$PWD/services" \
  --allow-env=SERVER_HEX,VENUE_SERVER_RELAYS,VENUE_SERVER_VENUES \
  services/restaurant-cvm/server.ts
