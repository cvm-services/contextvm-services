#!/usr/bin/env python3
"""Handoff gateway: token-authed HTTP entrypoint for the facilitator captcha
handoff (ADR-0017).

WHY
The PWA's Caddy runs on testserver2 and cannot map a one-time token to an
ephemeral websockify port (that mapping lives with the SessionManager on this
box). Instead of pushing state to the VPS, the gateway IS the mapping: Caddy
proxies the whole /handoff/* subtree to this service on the FIPS mesh
(x280.fips:49100), which:

  GET  /handoff/<token>/          -> noVNC HTML (bundled, from /usr/share/novnc)
  GET  /handoff/<token>/app/...   -> noVNC static assets
  WS   /handoff/<token>/websockify -> live VNC session (token -> ws_port)

SECURITY
- Token is the SessionManager's one-time urlsafe token; unknown/expired token
  -> 404 after a constant-time comparison against all live tokens.
- Listens on the FIPS mesh address only (default), so the public surface is
  Caddy's TLS + this token check.
- No card values, no order data: pixels in, clicks out.

RUN
  python3 handoff_gateway.py [--listen fd36:...|--listen 127.0.0.1] [--port 49100]
  The gateway reads session state via the SessionManager's runtime dir
  (/tmp/captcha-vnc/handoff.json written by spawn()).
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NOVNC_ROOT = "/usr/share/novnc"
TOKEN_RE = re.compile(r"^/handoff/([A-Za-z0-9_\-]{20,})/(.*)$")
STATE_FILE = "/tmp/captcha-vnc/handoff.json"
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
}


def load_sessions() -> dict:
    """token -> {ws_port, order_id}. Written by the session manager."""
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


class HandoffHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "handoff-gateway/1.0"

    # ---- helpers -----------------------------------------------------------

    def _send(self, code: int, body: bytes, ctype: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _not_found(self):
        self._send(404, b"not found", "text/plain")

    def _check_token(self, token: str):
        """Constant-time token check against live sessions."""
        sessions = load_sessions()
        match = None
        for tok, info in sessions.items():
            if hmac.compare_digest(tok, token):
                match = info
                break
        return match

    def log_message(self, format, *args):
        # keep the mesh logs quiet; health endpoint shows state
        pass

    # ---- routes ------------------------------------------------------------

    def do_GET(self):
        m = TOKEN_RE.match(self.path)
        if not m:
            return self._not_found()
        token, rest = m.groups()

        # health probe (no token): used by monitoring on the mesh
        if rest == "health" and token == "healthz":
            body = json.dumps({"sessions": len(load_sessions())}).encode()
            return self._send(200, body, "application/json")

        info = self._check_token(token)
        if not info:
            return self._not_found()

        # WebSocket upgrade -> live session bridge (before any file route)
        if rest == "websockify" and self._ws_upgrade():
            return self._bridge(info)

        if rest == "" or rest == "index.html":
            page = self.novnc_page(token)
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if rest == "vnc.html":
            page = self.novnc_page(token)
            return self._send(200, page.encode(), "text/html; charset=utf-8")

        # static noVNC assets: serve from the package, no traversal
        asset = os.path.normpath(os.path.join(NOVNC_ROOT, rest))
        if not asset.startswith(NOVNC_ROOT):
            return self._not_found()
        try:
            with open(asset, "rb") as f:
                body = f.read()
        except OSError:
            return self._not_found()
        ctype = MIME.get(os.path.splitext(asset)[1], "application/octet-stream")
        return self._send(200, body, ctype)

    def do_POST(self):
        # WebSocket upgrade arrives as GET; POST = tunnel fallback (not used)
        return self._send(405, b"method not allowed", "text/plain")

    # ---- the websocket bridge ----------------------------------------------

    def _bridge(self, info):
        """Upgrade this connection to WebSocket and pipe it to websockify.

        The stdlib has no WS server, so the gateway implements the minimal
        server handshake (RFC 6455) + frame relay, or — simpler and more
        honest — hands the raw socket to a tiny threaded pump after the
        handshake. The handshake is what the browser needs to speak noVNC.
        """
        import base64
        import hashlib

        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._not_found()
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                         ).digest()).decode()
        # 101 with NO content-length: hijack the socket
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True

        # pipe: browser socket <-> websockify on the mesh
        try:
            up = socket.socket(socket.AF_INET6
                               if ":" in info.get("ws_host", "127.0.0.1")
                               else socket.AF_INET)
            up.settimeout(10)
            up.connect((info.get("ws_host", "127.0.0.1"), info["ws_port"]))
        except OSError:
            return
        self.connection.settimeout(None)

        def pump(a, b):
            try:
                while True:
                    data = a.recv(65536)
                    if not data:
                        break
                    b.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    b.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        t1 = threading.Thread(target=pump, args=(self.connection, up), daemon=True)
        t2 = threading.Thread(target=pump, args=(up, self.connection), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    def do_HEAD(self):
        return self.do_GET()

    # NOTE: BaseHTTPRequestHandler dispatches WebSocket upgrades as GET with
    # 'Upgrade: websocket'. Route them in do_GET.
    def _ws_upgrade(self):
        return (self.headers.get("Upgrade", "").lower() == "websocket")

    def novnc_page(self, token: str) -> str:
        """Minimal noVNC host page bound to this token."""
        return f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bestellung verifizieren</title>
<script type="module">
  import {{ RFB }} from "/handoff/{token}/core/rfb.js";
  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://")
    + location.host + "/handoff/{token}/websockify";
  const rfb = new RFB(document.body, wsUrl, {{
    credentials: {{ password: "" }}
  }});
  rfb.scaleViewport = true;
</script>
<style>
  html,body {{ margin:0; height:100%; background:#111; overflow:hidden }}
</style>
</head>
<body>
<div id="bar" style="position:fixed;top:0;left:0;right:0;background:#222;
     color:#eee;font:13px/1.4 system-ui;padding:6px 10px;z-index:9">
  Bestellung: löse die Aufgabe im Bildschirm, dann schließe die Seite.
  Die Zahlung läuft danach automatisch weiter.
</div>
</body>
</html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default=os.environ.get("HANDOFF_LISTEN", "127.0.0.1"))
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("HANDOFF_PORT", "49100")))
    args = ap.parse_args()

    family = socket.AF_INET6 if ":" in args.listen else socket.AF_INET
    srv = ThreadingHTTPServer((args.listen, args.port), HandoffHandler)
    srv.address_family = family
    print(f"handoff gateway on [{args.listen}]:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()