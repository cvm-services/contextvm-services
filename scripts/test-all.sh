#!/usr/bin/env bash
# The repo runs tests under TWO runners and neither covers both.
#
#   deno task test   -> fails on the 12 files that import bun:test
#   bun test         -> fails on the 2 files that need the Deno runtime
#
# So "tests pass" was true of whichever half you happened to run, and a red result
# from the other half looked like a real failure. This script runs each file under
# the runner that can actually execute it, then fails if either side fails.
#
# Classification is by CONTENT, not filename: a file needs Deno if it uses
# Deno.test / Deno.env at module scope / npm: specifiers / import.meta.url.
set -uo pipefail

# Run from the repo root. `cd` to the script's own parent dir, not two levels up:
# a script in scripts/ is one level from the root, and getting this wrong made the
# first run find zero files and report success anyway.
ROOT="${1:-services/restaurant-cvm}"
cd "$(dirname "$0")/.." || exit 1

DENO_BIN="${DENO_BIN:-deno}"
BUN_BIN="${BUN_BIN:-bun}"
[[ -x "$HOME/.local/bin/deno" ]] && DENO_BIN="$HOME/.local/bin/deno"
[[ -x "$HOME/.local/bin/bun" ]] && BUN_BIN="$HOME/.local/bin/bun"

deno_files=()
bun_files=()

while IFS= read -r f; do
  case "$f" in
    *node_modules*) continue ;;
  esac
  if grep -qE 'Deno\.(test|env|exit|serve)|from "npm:|import\.meta' "$f" 2>/dev/null; then
    deno_files+=("$f")
  else
    bun_files+=("$f")
  fi
done < <(find "$ROOT" -name '*test*.ts' -not -path '*/node_modules/*' | sort)

echo "=== classification ==="
echo "deno: ${#deno_files[@]} file(s)"
echo "bun : ${#bun_files[@]} file(s)"

# A gate that passes on an empty set is not a gate. Fail loudly instead, because
# "0 files, both runners green" is exactly how a broken path looks healthy.
if [[ ${#deno_files[@]} -eq 0 && ${#bun_files[@]} -eq 0 ]]; then
  echo "RESULT: FAILED - no test files found under '$ROOT'" >&2
  echo "        (wrong working directory or wrong path argument)" >&2
  exit 2
fi

rc_total=0

if [[ ${#deno_files[@]} -gt 0 ]]; then
  echo
  echo "=== deno (--no-check: bun:test files are type-checked by their own runner) ==="
  "$DENO_BIN" test --no-check --allow-all "${deno_files[@]}" 2>&1 | tail -25
  drc=${PIPESTATUS[0]}
  echo "deno exit: $drc"
  [[ $drc -ne 0 ]] && rc_total=1
fi

if [[ ${#bun_files[@]} -gt 0 ]]; then
  echo
  echo "=== bun ==="
  "$BUN_BIN" test "${bun_files[@]}" 2>&1 | tail -20
  brc=${PIPESTATUS[0]}
  echo "bun exit: $brc"
  [[ $brc -ne 0 ]] && rc_total=1
fi

echo
if [[ $rc_total -eq 0 ]]; then
  echo "RESULT: both runners green"
else
  echo "RESULT: FAILED (see the runner that returned non-zero)"
fi
exit $rc_total
