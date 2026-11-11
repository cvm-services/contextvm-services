#!/usr/bin/env bash
# Read back the venue announcements (kind 11316/11317) from the ANNOUNCED relay
# set for both venue identities. Read-only: no key material, no publishing.
#
# usage: fetch-live-announcements.sh <outdir>
set -uo pipefail

OUT="${1:?usage: fetch-live-announcements.sh <outdir>}"
mkdir -p "$OUT"

DOPPELT_PK=fe700a09094950660077447bedd4e0b3abc14a82e95227b313aebf83b7798984
PIZZA_PK=ef070a5dcaaa368d05d6a248041195e9f3b388ea323ca0c0a1d73ed44e31ea2b
RELAYS=(wss://relay2.orangesync.tech wss://relay.primal.net)

for pair in "doppelt-kaese-berlin $DOPPELT_PK" "pizza-e-pasta-ruedesheimerplatz $PIZZA_PK"; do
  set -- $pair
  slug="$1"; pk="$2"
  for kind in 11316 11317; do
    f="$OUT/${slug}.${kind}.jsonl"
    : > "$f"
    for r in "${RELAYS[@]}"; do
      echo "### relay $r" >> "$f"
      timeout 25 nak req -k "$kind" -a "$pk" "$r" >> "$f" 2>&1
      echo "### exit $?" >> "$f"
    done
    n=$(grep -c '^{' "$f")
    echo "$slug $kind: $n event line(s) -> $f"
  done
done
