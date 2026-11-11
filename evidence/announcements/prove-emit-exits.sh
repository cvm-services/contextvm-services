#!/usr/bin/env bash
# Prove the emit CLI EXITS after a real publish (the defect that killed the
# 2026-10-10 run). Points the CLI at a local accept-all relay so no real relay
# is written to, publishes a throwaway event signed by a throwaway key, and
# fails if the process has to be killed.
#
# usage: prove-emit-exits.sh [outfile]
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
OUT="${1:-evidence/announcements/emit-exit-proof.txt}"
PORT=8791
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; kill "${RELAY_PID:-0}" 2>/dev/null' EXIT

~/.local/bin/deno run --allow-net evidence/announcements/tools-local-relay.ts "$PORT" > "$TMP/relay.log" 2>&1 &
RELAY_PID=$!

# wait for the port to answer
for _ in $(seq 1 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then exec 3>&-; break; fi
  sleep 0.25
done

start=$(date +%s.%N)
timeout 60 ~/.local/bin/deno run --allow-read=. --allow-write --allow-net \
  tools/emit-venue-announcement.ts \
  --venue venues/pizza-e-pasta-ruedesheimerplatz/venue.json --kind 11316 \
  --key-file "$TMP/throwaway.hex" \
  --relays "ws://127.0.0.1:$PORT" \
  > "$TMP/out.json" 2> "$TMP/out.err"
rc=$?
end=$(date +%s.%N)

{
  echo "# emit-venue-announcement.ts exit proof (local relay, no real relay touched)"
  echo
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "command: deno run tools/emit-venue-announcement.ts --venue venues/pizza-e-pasta-ruedesheimerplatz/venue.json --kind 11316 --key-file <throwaway> --relays ws://127.0.0.1:$PORT"
  echo "exit_code: $rc   (124 would mean it had to be killed by timeout)"
  echo "wall_seconds: $(echo "$end - $start" | bc)"
  echo "stdout_bytes: $(wc -c < "$TMP/out.json")"
  echo
  echo "--- CLI stderr"; cat "$TMP/out.err"
  echo "--- relay log"; cat "$TMP/relay.log"
} > "$OUT"

cat "$OUT"
if [ "$rc" -eq 124 ]; then echo "FAIL: CLI had to be killed" >&2; exit 1; fi
echo "PASS: CLI exited on its own (rc=$rc)"
