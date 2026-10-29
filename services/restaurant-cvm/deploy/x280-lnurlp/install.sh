#!/usr/bin/env bash
# Install the Option A customer API on x280 as the unprivileged `cvm` user.
#
# No OpenBao AppRole is used by the running service. The only credential is the
# LNURLP internal bearer, read once by this installer from the x280 AppRole and
# written to /etc/cvm/customer-api.env (0600 root); systemd injects it.
#
# Run as c08rad0r on x280:
#   bash services/restaurant-cvm/deploy/x280-lnurlp/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SERVICE_DIR=/opt/cvm/services/restaurant-cvm
ETC=/etc/cvm
UNIT=/etc/systemd/system/cvm-customer-api.service
SUDO="${SUDO:-sudo}"

die() { echo "x280-lnurlp-install: $*" >&2; exit 1; }

[ "$(id -un)" = "c08r4d0r" ] || die "run as c08r4d0r on x280"
[ -f "$REPO/services/restaurant-cvm/src/serve_customer_lnurlp.ts" ] || die "service source missing"
[ -f "$REPO/venues/three-buddies-berlin/menu.sats.fixture.json" ] || die "menu fixture missing"
[ -x "$HOME/.local/bin/deno" ] || die "Deno missing at ~/.local/bin/deno"
[ -x "$HOME/.hermes/scripts/fleet_secret.py" ] || die "fleet_secret.py missing"

echo "== user + dirs"
id cvm >/dev/null 2>&1 || $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin cvm
$SUDO install -d -o root -g root -m 0755 /opt/cvm/services "$SERVICE_DIR" "$SERVICE_DIR/src" "$ETC"

echo "== code + menu"
$SUDO install -m 0644 "$REPO/services/restaurant-cvm/src/serve_customer_lnurlp.ts" \
  "$SERVICE_DIR/src/serve_customer_lnurlp.ts"
$SUDO install -m 0644 "$REPO/venues/three-buddies-berlin/menu.sats.fixture.json" \
  "$ETC/three-buddies-menu.json"

echo "== Deno (system-wide for cvm)"
if [ ! -x /usr/local/bin/deno ]; then
  $SUDO install -m 0755 "$HOME/.local/bin/deno" /usr/local/bin/deno
fi
/usr/local/bin/deno --version | head -1

echo "== LNURLP internal token (OpenBao -> env, not printed)"
TOKEN="$("$HOME/.hermes/scripts/fleet_secret.py" get lnurlp-internal --field TOKEN 2>/dev/null || true)"
[ -n "$TOKEN" ] || die "cannot read lnurlp-internal from OpenBao (x280 AppRole grant?)"
TMP_ENV="$(mktemp /tmp/cvm-customer-api.env.XXXXXX)"
chmod 600 "$TMP_ENV"
TOKEN="$TOKEN" python3 - "$HERE/customer-api.env.example" "$TMP_ENV" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
token = os.environ["TOKEN"]
text = open(src).read().replace("__TOKEN__", token)
open(dst, "w").write(text)
PY
$SUDO install -m 0600 "$TMP_ENV" "$ETC/customer-api.env"
rm -f "$TMP_ENV"

echo "== unit (stop old c08r4d0r service, install Option A)"
$SUDO systemctl stop cvm-customer-api.service 2>/dev/null || true
$SUDO install -m 0644 "$HERE/cvm-customer-api.service" "$UNIT"
$SUDO systemctl daemon-reload
$SUDO systemctl enable cvm-customer-api.service >/dev/null
$SUDO systemctl restart cvm-customer-api.service
sleep 2

echo "== health"
FIPS="$(sed -n 's/^CVM_CUSTOMER_HOST=//p' "$ETC/customer-api.env" | tail -1 | tr -d '"')"
PORT="$(sed -n 's/^CVM_CUSTOMER_PORT=//p' "$ETC/customer-api.env" | tail -1 | tr -d '"')"
LOCAL="http://[$FIPS]:${PORT:-8793}/health"
if ! curl -fsS --max-time 5 "$LOCAL" >/tmp/cvm-lnurlp-health.json 2>/dev/null; then
  echo "   service unhealthy; journal:" >&2
  $SUDO journalctl -u cvm-customer-api.service -n 30 --no-pager >&2 || true
  exit 1
fi
cat /tmp/cvm-lnurlp-health.json
echo

echo "== publish the Option A customer UI"
HOST=vps2fips bash "$REPO/services/restaurant-cvm/deploy/x280/publish-order-next.sh"

echo "== public API"
curl -fsS --max-time 10 https://cvm-pwa.orangesync.tech/order-next-api/menu >/dev/null &&
  echo "   /order-next-api/menu: ok"
echo "== done"
echo "   customer UI: https://cvm-pwa.orangesync.tech/order-next/"
echo "   facilitator page: https://cvm-pwa.orangesync.tech/lnurlp/facilitator"
