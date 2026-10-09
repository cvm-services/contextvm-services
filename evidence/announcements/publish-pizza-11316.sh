#!/usr/bin/env bash
# Publish the corrected kind-11316 announcement for pizza-e-pasta-ruedesheimerplatz
# with the venue's OWN key (kind 11316 is NIP-16 replaceable, keyed by (kind,pubkey)).
#
# The venue secret never touches a command line: it is extracted from the 0600
# key file into a 0600 single-line file inside a 0700 mktemp dir, and that dir is
# removed on exit. `--dry-run` in this same script proves the payload first.
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

SLUG=pizza-e-pasta-ruedesheimerplatz
KINDS="${1:-11316}"
KEYFILE="/home/c03rad0r/.hermes/secrets/venues/$SLUG.nsec"
OUT=evidence/announcements/published-t7d410f66
mkdir -p "$OUT"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
grep -o 'HEX=[0-9a-f]\{64\}' "$KEYFILE" | head -1 | cut -d= -f2 > "$TMP/venue.hex"
chmod 600 "$TMP/venue.hex"
if [ ! -s "$TMP/venue.hex" ]; then echo "no HEX= in $KEYFILE" >&2; exit 1; fi

for kind in $KINDS; do
  echo "--- dry-run $SLUG $kind"
  ~/.local/bin/deno run --allow-read=. --allow-read="$TMP" tools/emit-venue-announcement.ts \
    --venue "venues/$SLUG/venue.json" --kind "$kind" --dry-run > "$TMP/dry.$kind.json"
  echo "--- publish $SLUG $kind"
  ~/.local/bin/deno run --allow-read=. --allow-read="$TMP" --allow-net \
    tools/emit-venue-announcement.ts \
    --venue "venues/$SLUG/venue.json" --kind "$kind" \
    --key-file "$TMP/venue.hex" \
    --relays wss://relay2.orangesync.tech,wss://relay.primal.net \
    > "$OUT/$SLUG.$kind.json" 2> "$OUT/$SLUG.$kind.err"
  echo "wrote $OUT/$SLUG.$kind.json"
  cat "$OUT/$SLUG.$kind.err"
done
