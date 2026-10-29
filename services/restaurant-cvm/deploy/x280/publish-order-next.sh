#!/usr/bin/env bash
# Publish the new customer UI to the FIPS exit node (testserver2 / vps2fips).
#
#   bash services/restaurant-cvm/deploy/x280/publish-order-next.sh
#   HOST=debian@testserver2.fips ...   (override the SSH target)
#
# It writes /opt/tollgate/cvm-pwa/order-next/{index.html,vendor/qr.js}. The
# Caddy route (/order-next/ and /order-next-api/*) lives in cvm-registry's
# deploy/caddy-vhost-cvm-pwa.caddy; this script only ships the static files.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
WEB="$REPO/services/restaurant-cvm/web"
HOST="${HOST:-vps2fips}"
DEST="${DEST:-/opt/tollgate/cvm-pwa/order-next}"
API_PREFIX="/order-next-api"

[ -f "$WEB/customer.html" ] || { echo "missing $WEB/customer.html" >&2; exit 1; }
[ -f "$WEB/vendor/qr.js" ] || { echo "missing $WEB/vendor/qr.js" >&2; exit 1; }

BUNDLE="$(mktemp -d /tmp/cvm-order-next-XXXX)"
trap 'rm -rf "$BUNDLE"' EXIT
mkdir -p "$BUNDLE/vendor"

# Inject the API base; customer.html already reads window.__API__. The marker is
# literal so a changed document fails the deploy instead of shipping a page
# that silently calls the wrong origin.
python3 - "$WEB/customer.html" "$BUNDLE/index.html" "$API_PREFIX" <<'PY'
import sys
src, dst, api = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(src, encoding="utf-8").read()
marker = '<meta charset="utf-8">'
if marker not in html:
    raise SystemExit("customer.html: charset marker missing; refusing to guess")
inject = marker + f'\n  <script>window.__API__="{api}";</script>'
if f'window.__API__="{api}"' in html:
    raise SystemExit("customer.html already injects the target __API__; refusing to double-inject")
open(dst, "w", encoding="utf-8").write(html.replace(marker, inject, 1))
PY

cp "$WEB/vendor/qr.js" "$BUNDLE/vendor/qr.js"

echo "== shipping to $HOST:$DEST"
tar -C "$BUNDLE" -cf - . | ssh -o BatchMode=yes "$HOST" \
  "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST && sudo find $DEST -type d -exec chmod 755 {} + && sudo find $DEST -type f -exec chmod 644 {} +"

ssh -o BatchMode=yes "$HOST" "grep -q 'window.__API__=\"$API_PREFIX\"' '$DEST/index.html'" ||
  { echo "injection not present on the host" >&2; exit 1; }
echo "   index.html + vendor/qr.js installed"

echo "== public checks (Caddy must already have the /order-next routes)"
for p in "/order-next/" "/order-next-api/menu"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "https://cvm-pwa.orangesync.tech$p" || true)"
  echo "   $p -> $code"
done
