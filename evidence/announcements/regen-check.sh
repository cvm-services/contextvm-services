#!/usr/bin/env bash
# Re-generate the four dry-run artifacts from the CURRENT emitter + venue.json and
# prove they byte-match the committed artifacts (i.e. the committed evidence is
# not stale relative to the tree it is supposed to describe).
#
# usage: regen-check.sh <tmpdir-for-fresh-dryruns>
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

TMP="${1:?usage: regen-check.sh <tmpdir>}"
mkdir -p "$TMP"
rc=0

for pair in "doppelt-kaese-berlin" "pizza-e-pasta-ruedesheimerplatz"; do
  for kind in 11316 11317; do
    ~/.local/bin/deno run --allow-read --allow-write tools/emit-venue-announcement.ts \
      --venue "venues/$pair/venue.json" --kind "$kind" --dry-run > "$TMP/$pair.$kind.json" 2> "$TMP/$pair.$kind.err"
    if diff -q "evidence/announcements/$pair.$kind.json" "$TMP/$pair.$kind.json" >/dev/null; then
      echo "MATCH  $pair $kind (committed artifact == fresh dry-run)"
    else
      echo "DIFF   $pair $kind — committed artifact is NOT what the tree regenerates"
      diff "evidence/announcements/$pair.$kind.json" "$TMP/$pair.$kind.json" | head -40
      rc=1
    fi
  done
done
exit $rc
