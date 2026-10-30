#!/usr/bin/env bash
# live-smoke.sh — operator helper for the real customer -> facilitator -> venue run.
#
# This is the PAID tier. The free PWA regression is
# services/restaurant-cvm/tools/test_e2e_two_phones.py.
#
# No secret belongs in this file. The session API token and the venue phone are
# materialized by the private trust-root into a 0600 operator env; source it
# before running, or export the variables yourself.
#
# Usage:
#   source ~/.hermes/cvm/session-api.env
#   scripts/live-smoke.sh preflight
#   scripts/live-smoke.sh session ORDER=o_...
#   scripts/live-smoke.sh wait SESSION=s_...
#   scripts/live-smoke.sh complete SESSION=s_... REF=TB-1234
#   scripts/live-smoke.sh complete SESSION=s_... UNKNOWN=1
#   scripts/live-smoke.sh verify SESSION=s_...
#   scripts/live-smoke.sh collect
#   scripts/live-smoke.sh cleanup SESSION=s_...
#
set -euo pipefail

: "${CVM_SESSION_API:?set CVM_SESSION_API (session API base URL)}"
: "${CVM_SESSION_TOKEN:?set CVM_SESSION_TOKEN (operator bearer; 0600 env)}"
: "${CVM_PUBLIC_BASE:?set CVM_PUBLIC_BASE (public PWA origin)}"

ART="${CVM_SMOKE_ARTIFACTS:-artifacts/live-smoke}"
mkdir -p "$ART"
AUTH=(-H "authorization: Bearer ${CVM_SESSION_TOKEN}")
JSON=(-H "content-type: application/json")

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing $1"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -m 30 -X "$method" "${AUTH[@]}" "${JSON[@]}" \
      --data "$body" "${CVM_SESSION_API}${path}"
  else
    curl -fsS -m 30 -X "$method" "${AUTH[@]}" "${CVM_SESSION_API}${path}"
  fi
}

snapshot_card() {
  local label="$1"
  [ -n "${CVM_CARD_CMD:-}" ] || { say "card: skipped (CVM_CARD_CMD unset)"; return 0; }
  mkdir -p "$ART"
  bash -c "$CVM_CARD_CMD" >"$ART/card-${label}.json" 2>"$ART/card-${label}.err" \
    || { say "card: command failed (see $ART/card-${label}.err)"; return 0; }
  say "card: $ART/card-${label}.json"
}

snapshot_treasury() {
  local label="$1"
  [ -n "${CVM_TREASURY_CMD:-}" ] || { say "treasury: skipped (CVM_TREASURY_CMD unset)"; return 0; }
  mkdir -p "$ART"
  bash -c "$CVM_TREASURY_CMD" >"$ART/treasury-${label}.json" 2>"$ART/treasury-${label}.err" \
    || { say "treasury: command failed (see $ART/treasury-${label}.err)"; return 0; }
  say "treasury: $ART/treasury-${label}.json"
}

cmd_preflight() {
  need curl; need jq
  mkdir -p "$ART"
  say "== session API"
  api GET /sessions | jq -e '.sessions' >/dev/null || fail "session API did not answer"
  say "   ok"
  say "== facilitator page"
  curl -fsS -m 20 "$CVM_PUBLIC_BASE/lnurlp/facilitator" -o /dev/null \
    || fail "facilitator page did not answer"
  say "   ok"
  say "== configured phone"
  if [ -n "${CVM_PHONE:-}" ]; then
    say "   present (country=${CVM_PHONE_COUNTRY:-?} mode=${CVM_PHONE_MODE:-?})"
  else
    say "   WARN: CVM_PHONE is unset; the launcher will abort phone-not-configured"
  fi
  say "== card / treasury before"
  snapshot_card before
  snapshot_treasury before
  say "artifacts: $ART"
}

cmd_session() {
  local order="${ORDER:?set ORDER=o_...}"
  mkdir -p "$ART"
  api POST /sessions "{\"order_id\":\"$order\"}" >"$ART/session.json"
  jq . "$ART/session.json"
  say ""
  say "VNC:    $(jq -r '.novnc_url // empty' "$ART/session.json")"
  say "start:  ${CVM_PUBLIC_BASE}/lnurlp/orders/${order}/start"
  say "session: $(jq -r '.session_id' "$ART/session.json")"
}

cmd_wait() {
  local sid="${SESSION:?set SESSION=s_...}"
  local timeout="${TIMEOUT:-1500}"
  local start now state
  start=$(date +%s)
  while :; do
    state=$(api GET "/sessions/${sid}" | tee "$ART/session-latest.json" | jq -r '.state')
    say "state: $state"
    case "$state" in
      completed|outcome_unknown|failed|expired)
        cp "$ART/session-latest.json" "$ART/final-session.json"
        say "terminal: $state"
        return 0
        ;;
    esac
    now=$(date +%s)
    if [ $((now - start)) -ge "$timeout" ]; then
      fail "no terminal state after ${timeout}s (last: $state)"
    fi
    sleep 3
  done
}

cmd_complete() {
  local sid="${SESSION:?set SESSION=s_...}"
  local outcome="confirmed"
  [ "${UNKNOWN:-0}" = "1" ] && outcome="unknown"
  local ref="${REF:-}"
  if [ "$outcome" = "confirmed" ] && [ -z "$ref" ]; then
    fail "REF is required for a confirmed completion (or set UNKNOWN=1)"
  fi
  local body
  if [ -n "$ref" ]; then
    body=$(jq -nc --arg o "$outcome" --arg r "$ref" '{outcome:$o, venue_ref:$r}')
  else
    body=$(jq -nc --arg o "$outcome" '{outcome:$o}')
  fi
  api POST "/sessions/${sid}/complete" "$body" | tee "$ART/complete.json" | jq .
}

cmd_verify() {
  local sid="${SESSION:?set SESSION=s_...}"
  local state
  state=$(api GET "/sessions/${sid}" | tee "$ART/verify-session.json" | jq -r '.state')
  say "state: $state"
  case "$state" in
    completed|outcome_unknown) ;;
    *) fail "expected completed/outcome_unknown, got $state" ;;
  esac
  if [ -f "$ART/card-before.json" ]; then
    snapshot_card after
    if [ -f "$ART/card-after.json" ]; then
      jq -n --slurpfile a "$ART/card-before.json" --slurpfile b "$ART/card-after.json" '
        {before: ([$a[0][]?.bal] | add), after: ([$b[0][]?.bal] | add)}
        | .delta = ((.after // 0) - (.before // 0))' | tee "$ART/card-delta.json" | jq .
    fi
  fi
  if [ -f "$ART/treasury-before.json" ]; then
    snapshot_treasury after
    if [ -f "$ART/treasury-after.json" ]; then
      jq -n --slurpfile a "$ART/treasury-before.json" --slurpfile b "$ART/treasury-after.json" '
        {before: ($a[0].balance_sats // null), after: ($b[0].balance_sats // null)}
        | .delta = (if .before != null and .after != null then .after - .before else null end)'
    fi
  fi
  say "artifacts: $ART"
}

cmd_collect() {
  mkdir -p "$ART"
  # The launcher redacts phone/card fields before writing these.
  cp /tmp/vt-*.png "$ART/" 2>/dev/null || true
  # Never collect the raw session env or tokens.
  say "screenshots: $ART"
}

cmd_cleanup() {
  local sid="${SESSION:?set SESSION=s_...}"
  api POST "/sessions/${sid}/cancel" '{}' | jq . || true
  rm -f "/tmp/cvm-session-${sid}.complete" 2>/dev/null || true
  say "cancelled $sid"
}

cmd_report() {
  say "== live smoke report"
  [ -f "$ART/session.json" ] && jq -r '"order: \(.order_id)\nsession: \(.session_id)"' "$ART/session.json"
  [ -f "$ART/final-session.json" ] && jq -r '"final: \(.state)" + (if .venue_ref then " · " + .venue_ref else "" end)' "$ART/final-session.json"
  [ -f "$ART/card-delta.json" ] && jq -r '"card delta: \(.delta)"' "$ART/card-delta.json"
  say "artifacts: $ART"
}

cmd="${1:-help}"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    *=*) export "${1%%=*}=${1#*=}" ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

case "$cmd" in
  preflight) cmd_preflight ;;
  session)   cmd_session ;;
  wait)      cmd_wait ;;
  complete)  cmd_complete ;;
  verify)    cmd_verify ;;
  collect)   cmd_collect ;;
  cleanup)   cmd_cleanup ;;
  report)    cmd_report ;;
  help|-h|--help)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) fail "unknown command: $cmd" ;;
esac
