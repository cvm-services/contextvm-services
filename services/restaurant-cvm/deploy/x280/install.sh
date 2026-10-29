#!/usr/bin/env bash
# Install the customer API on x280 (the FIPS node).
#
# Run from the repo checkout on x280 as the operator user:
#   bash services/restaurant-cvm/deploy/x280/install.sh
#
# This installs only non-secret config. The two credentials resolve from OpenBao
# via ~/.hermes/openbao/env; an existing /etc/cvm/customer-api.env is preserved
# so an operator edit (FX, card, host) is never overwritten by a re-run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SERVICE_DIR="$REPO/services/restaurant-cvm"
ETC=/etc/cvm
FIPS_D=/etc/fips/fips.d
SUDO="${SUDO:-sudo}"

die() { echo "install: $*" >&2; exit 1; }

[ "$(id -un)" = "c08r4d0r" ] || die "run as c08r4d0r on x280 (got $(id -un))"
[ -x "$HOME/.local/bin/deno" ] || die "no Deno at $HOME/.local/bin/deno"
[ -f "$REPO/venues/three-buddies-berlin/menu.sats.fixture.json" ] ||
  die "menu fixture missing under $REPO/venues/"
[ -f "$HERE/cvm-customer-api.service" ] || die "unit template missing"
[ -f "$HERE/customer-api.env.example" ] || die "env example missing"
[ -f "$HERE/61-cvm-customer-api.nft" ] || die "nft drop-in missing"

echo "== /etc/cvm"
$SUDO install -d -o root -g root -m 0755 "$ETC"
$SUDO install -m 0644 \
  "$REPO/venues/three-buddies-berlin/menu.sats.fixture.json" \
  "$ETC/three-buddies-menu.json"
$SUDO install -m 0644 "$HERE/cvm-import-map.json" "$ETC/cvm-import-map.json"

if [ -f "$ETC/customer-api.env" ]; then
  echo "   keeping existing $ETC/customer-api.env"
else
  $SUDO install -m 0600 "$HERE/customer-api.env.example" "$ETC/customer-api.env"
  echo "   wrote $ETC/customer-api.env from the example"
fi

echo "== systemd unit"
$SUDO install -m 0644 "$HERE/cvm-customer-api.service" \
  /etc/systemd/system/cvm-customer-api.service
$SUDO systemctl daemon-reload

echo "== FIPS ingress (source-scoped to the exit node)"
$SUDO install -d -o root -g root -m 0755 "$FIPS_D"
$SUDO install -m 0644 "$HERE/61-cvm-customer-api.nft" \
  "$FIPS_D/61-cvm-customer-api.nft"
$SUDO systemctl restart fips-firewall

echo "== service"
$SUDO systemctl enable cvm-customer-api.service >/dev/null
$SUDO systemctl restart cvm-customer-api.service
sleep 2

HOST="$($SUDO sed -n 's/^CVM_CUSTOMER_HOST=//p' "$ETC/customer-api.env" | tail -1 | tr -d '"')"
if [ -n "$HOST" ]; then
  case "$HOST" in
    *:*) URL="http://[$HOST]:8793/menu" ;;
    *)   URL="http://$HOST:8793/menu" ;;
  esac
else
  URL="http://127.0.0.1:8793/menu"
fi

curl -fsS --max-time 5 "$URL" >/dev/null ||
  die "/menu failed at $URL; see: journalctl -u cvm-customer-api -n 40"
echo "   /menu on ${HOST:-127.0.0.1}: ok"

echo "== done. Publish the UI with: $HERE/publish-order-next.sh"
