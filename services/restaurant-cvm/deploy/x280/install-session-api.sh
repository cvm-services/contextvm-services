#!/usr/bin/env bash
# Install/refresh the venue checkout session API on x280.
# The 2fiat wallet token is materialized from OpenBao (secret/fleet/2fiat);
# without it the card helper fails with "no 2fiat wallet token" and every
# launcher dies before the browser steps.
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

python3 - "$ENV" "$TOK" <<'PY'
import sys
p, tok = sys.argv[1], sys.argv[2]
lines = [l for l in open(p).read().splitlines() if not l.startswith("TWO_FIAT_TOKEN=")]
lines.append("TWO_FIAT_TOKEN=" + tok)
open(p, "w").write("\n".join(lines) + "\n")
PY
chmod 600 "$ENV"

install -m 0644 "$HERE/cvm-session-api.service" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now cvm-session-api.service
systemctl --user restart cvm-session-api.service
sleep 2
systemctl --user is-active cvm-session-api.service
echo "2fiat token materialized (len ${#TOK}); unit active"
