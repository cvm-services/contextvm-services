#!/usr/bin/env bash
# Install/refresh the venue checkout session API on x280.
#
# The 2fiat wallet token and the venue phone are materialized from OpenBao:
#   secret/fleet/2fiat        -> TWO_FIAT_TOKEN
#   secret/fleet/venue-phone  -> CVM_PHONE / CVM_PHONE_COUNTRY / CVM_PHONE_MODE
# Neither value is in git or printed. Without the 2fiat token the card helper
# dies; without the phone the launcher refuses to start (fail closed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="$HOME/.hermes/cvm"
ENV="$ENV_DIR/session-api.env"
UNIT="$HOME/.config/systemd/user/cvm-session-api.service"

die() { echo "session-api-install: $*" >&2; exit 1; }
[ "$(id -un)" = "c08r4d0r" ] || die "run as c08r4d0r on x280"

mkdir -p "$ENV_DIR"
if [ ! -f "$ENV" ]; then
  install -m 0600 "$HERE/session-api.env.example" "$ENV"
fi

TOK="$("$HOME/.hermes/scripts/fleet_secret.py" get 2fiat --field 2fiat 2>/dev/null || true)"
[ -n "$TOK" ] || die "cannot read 2fiat from OpenBao (x280 AppRole grant?)"

PHONE="$("$HOME/.hermes/scripts/fleet_secret.py" get venue-phone --field phone 2>/dev/null || true)"
PCOUNTRY="$("$HOME/.hermes/scripts/fleet_secret.py" get venue-phone --field country 2>/dev/null || true)"
PMODE="$("$HOME/.hermes/scripts/fleet_secret.py" get venue-phone --field mode 2>/dev/null || true)"
[ -n "$PHONE" ] || die "cannot read venue-phone from OpenBao (x280 AppRole grant?)"

python3 - "$ENV" "$TOK" "$PHONE" "$PCOUNTRY" "$PMODE" <<'PY'
import sys
p, tok, phone, country, mode = sys.argv[1:6]
managed = ("TWO_FIAT_TOKEN=", "CVM_PHONE=", "CVM_PHONE_COUNTRY=", "CVM_PHONE_MODE=")
lines = [l for l in open(p).read().splitlines() if not l.startswith(managed)]
lines += [
    "TWO_FIAT_TOKEN=" + tok,
    "CVM_PHONE=" + phone,
    "CVM_PHONE_COUNTRY=" + (country or "US"),
    "CVM_PHONE_MODE=" + (mode or "jmp"),
]
open(p, "w").write("\n".join(lines) + "\n")
PY
chmod 600 "$ENV"

install -m 0644 "$HERE/cvm-session-api.service" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now cvm-session-api.service
systemctl --user restart cvm-session-api.service
sleep 2
systemctl --user is-active cvm-session-api.service
echo "materialized 2fiat token (len ${#TOK}) and venue phone; values not printed"
