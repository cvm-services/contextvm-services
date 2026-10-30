#!/usr/bin/env python3
"""handoff_gateway.py — token-scoped noVNC door for one captcha session.

Why this exists
  `captcha_session.py` starts Xvfb + x11vnc + websockify on loopback/FIPS, but
  websockify has no notion of "which order is this". This gateway is the missing
  public surface: a 32-byte token in the path selects exactly one live websockify
  port, serves the noVNC client, and proxies the WebSocket. When the session is
  torn down its token disappears from the map and the URL stops working.

Routes (prefix is configurable):
  GET /venue/view/<token>/                     -> redirect to vnc.html
  GET /venue/view/<token>/<static file>        -> /usr/share/novnc/<file>
  GET /venue/view/<token>/websockify           -> raw WebSocket proxy
  GET /health                                  -> {ok, sessions}

Security
  * tokens are 32 random bytes, compared in constant time;
  * only the token's mapped port is reachable — no port is user-controlled;
  * static paths are resolved under the noVNC root and traversal is refused;
  * bind on the FIPS mesh; the nft rule admits only the Caddy exit node.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import mimetypes
import os
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BIND = os.environ.get("GATEWAY_BIND", "127.0.0.1")
PORT = int(os.environ.get("GATEWAY_PORT", "8097"))
PREFIX = os.environ.get("GATEWAY_PREFIX", "/venue/view/").rstrip("/") + "/"
HANDOFF = Path(os.environ.get("GATEWAY_HANDOFF", "/tmp/captcha-vnc/handoff.json"))
NOVNC = Path(os.environ.get("GATEWAY_NOVNC", "/usr/share/novnc"))
MAX_HEAD = 64 * 1024


def load_handoff(path: Path = HANDOFF) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items()
            if isinstance(v, dict) and isinstance(v.get("ws_port"), int)}


def find_session(token: str, handoff: dict) -> dict | None:
    if not token:
        return None
    # Constant-time compare across the live tokens: a short-circuiting dict
    # lookup is fine for a random 32-byte key, but this also denies timing
    # oracles if a token is ever shortened by a caller.
    for known, rec in handoff.items():
        if hmac.compare_digest(token, known):
            return rec
    return None


def parse_view_path(path: str, prefix: str = PREFIX) -> tuple[str, str] | None:
    """Split /venue/view/<token>/<rest> -> (token, rest). None if not a view."""
    if not path.startswith(prefix):
        return None
    tail = path[len(prefix):]
    token, _, rest = tail.partition("/")
    if not token:
        return None
    return token, rest


def resolve_static(root: Path, rel: str) -> Path | None:
    """Resolve a static file under root; refuse traversal and directories."""
    rel = unquote(rel or "vnc.html")
    if rel in ("", "/"):
        rel = "vnc.html"
    candidate = (root / rel.lstrip("/")).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    if candidate.is_dir():
        candidate = candidate / "index.html"
    return candidate if candidate.is_file() else None


def needs_vnc_redirect(rest: str, query: str) -> bool:
    """A bare vnc.html / token root needs the auto-connect query.

    noVNC falls back to wss://host/websockify without `path`; the browser then
    gets a 404. Redirecting makes bare token links/bookmarks work.
    """
    return rest in ("", "/", "vnc.html") and "path" not in parse_qs(query)


def _redirect(token: str) -> bytes:
    target = (f"{PREFIX}{token}/vnc.html?autoconnect=1&resize=scale"
              f"&path={PREFIX.lstrip('/')}{token}/websockify")
    return (f"HTTP/1.1 302 Found\r\nLocation: {target}\r\n"
            "Cache-Control: no-store\r\nContent-Length: 0\r\n\r\n").encode()


async def _read_head(reader: asyncio.StreamReader) -> bytes:
    try:
        return await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as exc:
        raise ConnectionError("bad request head") from exc


def _first_line(head: bytes) -> tuple[str, str]:
    line = head.split(b"\r\n", 1)[0].decode("latin-1")
    parts = line.split(" ")
    if len(parts) < 2:
        raise ConnectionError("bad request line")
    return parts[0].upper(), parts[1]


def _header(head: bytes, name: str) -> str:
    want = name.lower() + ":"
    for line in head.split(b"\r\n")[1:]:
        if b":" not in line:
            continue
        k, v = line.split(b":", 1)
        if k.decode("latin-1").strip().lower() + ":" == want:
            return v.decode("latin-1").strip()
    return ""


async def _serve_static(writer: asyncio.StreamWriter, file: Path) -> None:
    body = file.read_bytes()
    ctype = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
    if file.suffix == ".js":
        ctype = "text/javascript"
    head = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\n\r\n"
    ).encode()
    writer.write(head + body)
    await writer.drain()


async def _proxy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 head: bytes, host: str, port: int) -> None:
    up_r, up_w = await asyncio.open_connection(host, port)
    # Rewrite only the request target; websockify accepts any path.
    lines = head.split(b"\r\n")
    try:
        _, target = _first_line(head)
        lines[0] = f"GET /{urlparse(target).path.rsplit('/', 1)[-1]} HTTP/1.1".encode()
    except ConnectionError:
        pass
    up_w.write(b"\r\n".join(lines))
    await up_w.drain()

    async def pump(src, dst):
        try:
            while True:
                chunk = await src.read(65536)
                if not chunk:
                    break
                dst.write(chunk)
                await dst.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass

    await asyncio.gather(pump(reader, up_w), pump(up_r, writer))
    for w in (up_w, writer):
        try:
            w.close()
        except Exception:
            pass


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        head = await _read_head(reader)
        method, target = _first_line(head)
        path = unquote(urlparse(target).path)

        if path == "/health":
            body = json.dumps({"ok": True, "sessions": len(load_handoff())}).encode()
            writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
                         + f"content-length: {len(body)}\r\n\r\n".encode() + body)
            await writer.drain()
            return

        parsed = parse_view_path(path)
        if not parsed:
            body = b"not found"
            writer.write(b"HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\n\r\n" + body)
            await writer.drain()
            return
        token, rest = parsed
        rec = find_session(token, load_handoff())
        if not rec:
            body = b"session expired"
            writer.write(b"HTTP/1.1 404 Not Found\r\ncontent-length: 15\r\n\r\n" + body)
            await writer.drain()
            return

        if method == "GET" and needs_vnc_redirect(rest, urlparse(target).query):
            writer.write(_redirect(token))
            await writer.drain()
            return

        if rest == "websockify":
            await _proxy(reader, writer, head,
                         str(rec.get("ws_host") or "127.0.0.1"),
                         int(rec["ws_port"]))
            return

        file = resolve_static(NOVNC, rest)
        if not file:
            body = b"not found"
            writer.write(b"HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\n\r\n" + body)
            await writer.drain()
            return
        await _serve_static(writer, file)
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    if not NOVNC.is_dir():
        print(json.dumps({"fatal": "novnc_missing", "path": str(NOVNC)}),
              file=sys.stderr)
        raise SystemExit(2)
    server = await asyncio.start_server(handle, BIND, PORT)
    print(json.dumps({"listening": PORT, "bind": BIND, "prefix": PREFIX,
                      "novnc": str(NOVNC), "handoff": str(HANDOFF),
                      "sessions": len(load_handoff())}), file=sys.stderr)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
