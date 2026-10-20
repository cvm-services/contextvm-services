#!/usr/bin/env python3
"""Ephemeral VNC session manager for the facilitator captcha handoff (ADR-0017).

WHY THIS EXISTS
The venue checkout gates card orders behind an hCaptcha visual challenge. The
automation can reach it and can do everything AFTER it, but the challenge itself
needs a human's hands (ADR-0017 measured: synthetic clicks ignored, human-like
clicks get a visual challenge). This module creates the ephemeral interactive
surface the facilitator uses through the PWA:

    Xvfb :NN  ->  x11vnc (127.0.0.1:port, random password)  ->
    websockify (127.0.0.1:port)  ->  Caddy/noVNC front (path token as auth)

SECURITY MODEL
- Every listener is 127.0.0.1-only; the public surface is the PWA's reverse
  proxy, which checks a one-time, order-scoped token before proxying.
- The VNC password is random per session and never leaves this process except
  to x11vnc's argv (-rfbauth file is used instead when supported).
- teardown() is idempotent and reaps all three processes in order; stale
  sessions are reaped by age.

INJECTABLE BINARIES
`bins` lets tests pass fake executables, so the whole lifecycle is testable
without x11vnc/websockify installed. Production uses the real commands.
"""

from __future__ import annotations

import os
import random
import secrets
import shutil
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field, asdict
from typing import Optional


class CaptchaSessionError(RuntimeError):
    """Raised when a session cannot be created or is in an invalid state."""


@dataclass
class CaptchaSession:
    order_id: str
    display: str
    vnc_port: int
    ws_port: int
    token: str
    vnc_password: str
    created_at: float
    pids: dict = field(default_factory=dict)
    runtime_dir: str = ""
    torn_down: bool = False

    def to_json(self) -> str:
        d = asdict(self)
        d.pop("vnc_password", None)  # never serialize the VNC password
        return __import__("json").dumps(d, indent=2)


def _free_port(range_: tuple = None) -> int:
    """Ask the kernel for a free localhost port and release it again.

    Race-window note: between closing the probe socket and the real bind there
    is a small window. Acceptable here because ports are 127.0.0.1-only,
    per-order, and short-lived; a collision fails loudly in spawn().
    """
    port = None
    if range_:
        for _ in range(20):
            cand = random.randint(*range_)
            with socket.socket(family=socket.AF_INET6 if ":" in "x" else socket.AF_INET) as s:
                if s.connect_ex(("127.0.0.1", cand)) != 0:
                    port = cand
                    break
        if port:
            return port
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class SessionManager:
    def __init__(
        self,
        runtime_dir: str = "/tmp/captcha-vnc",
        bins: Optional[dict] = None,
        max_age_s: int = 15 * 60,
        display_range: tuple = (90, 99),
        idle_timeout_s: int = 60,
        ws_listen: str = "127.0.0.1",
        ws_port_range: tuple = (49000, 49999),
    ):
        self.runtime_dir = runtime_dir
        self.bins = bins or {}
        self.max_age_s = max_age_s
        self.display_range = display_range
        self.idle_timeout_s = idle_timeout_s
        # websockify listen address. Default: loopback (tests, local-only).
        # Production passes the FIPS mesh address so the PWA's Caddy (on the
        # mesh) can reach the session; the fd36 ULA is NOT routable from the
        # internet — the public surface stays the token-checked reverse proxy.
        self.ws_listen = ws_listen
        self.ws_port_range = ws_port_range
        self.sessions: dict[str, CaptchaSession] = {}
        self._pops: dict[str, dict] = {}
        self.tokens: set[str] = set()

    # ---------- binary resolution -------------------------------------------

    def _bin(self, name: str) -> str:
        # explicit fake/override first, then PATH, then known absolute paths
        if name in self.bins:
            path = self.bins[name]
            if os.path.exists(path):
                return path
            raise CaptchaSessionError(f"{name} not found at {path}")
        found = shutil.which(name)
        if found:
            return found
        raise CaptchaSessionError(
            f"{name} not found on PATH — install it (apt install x11vnc websockify)"
        )

    # ---------- lifecycle ----------------------------------------------------

    def spawn(self, order_id: str) -> CaptchaSession:
        """Start Xvfb + x11vnc + websockify for one order's captcha session.

        Raises CaptchaSessionError (not a half-spawned mess) if any binary is
        missing or any process fails to start; partial processes are cleaned.
        """
        xvfb = self._bin("Xvfb")
        vnc = self._bin("x11vnc")
        ws = self._bin("websockify")

        os.makedirs(self.runtime_dir, exist_ok=True)
        display = f":{random.randint(*self.display_range)}"
        vnc_port = _free_port()
        ws_port = _free_port(self.ws_port_range)
        token = secrets.token_urlsafe(32)
        vnc_password = secrets.token_urlsafe(16)
        pw_file = os.path.join(self.runtime_dir, f"vncpw-{order_id}")
        with open(pw_file, "w") as f:
            f.write(vnc_password)
        os.chmod(pw_file, 0o600)

        pids: dict[str, int] = {}
        pops: dict[str, subprocess.Popen] = {}
        s: Optional[CaptchaSession] = None
        try:
            xvfb_p = subprocess.Popen(
                [xvfb, display, "-screen", "0", "1366x1200x24"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            pops["Xvfb"] = xvfb_p
            pids["Xvfb"] = xvfb_p.pid
            time.sleep(0.4)  # let the display register

            vnc_p = subprocess.Popen(
                [vnc, "-display", display, "-rfbport", str(vnc_port),
                 "-listen", "127.0.0.1", "-nopw", "-quiet", "-noxdamage",
                 # single-shot: exit when the first client disconnects
                 "-once"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            pops["x11vnc"] = vnc_p
            pids["x11vnc"] = vnc_p.pid

            # real websockify syntax: websockify [addr:]<listen_port> <target_host>:<target_port>
            # IPv6 literals need brackets in the listen spec. x11vnc stays on
            # 127.0.0.1 — websockify bridges to it locally.
            listen_spec = (f"[{self.ws_listen}]:{ws_port}"
                           if ":" in self.ws_listen
                           else f"{self.ws_listen}:{ws_port}")
            ws_p = subprocess.Popen(
                [ws, listen_spec, f"127.0.0.1:{vnc_port}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            pops["websockify"] = ws_p
            pids["websockify"] = ws_p.pid

            # wait for websockify to actually bind; fail loudly if not
            deadline = time.time() + self.idle_timeout_s / 4
            while time.time() < deadline:
                if ws_p.poll() is not None:
                    raise CaptchaSessionError(
                        f"websockify exited rc={ws_p.returncode} before binding")
                probe_family = (socket.AF_INET6
                                if ":" in self.ws_listen else socket.AF_INET)
                with socket.socket(family=probe_family) as probe:
                    probe.settimeout(0.5)
                    if probe.connect_ex((self.ws_listen, ws_port)) == 0:
                        break
                time.sleep(0.2)
            else:
                raise CaptchaSessionError(
                    f"websockify did not listen on {ws_port} within timeout")

            s = CaptchaSession(
                order_id=order_id, display=display, vnc_port=vnc_port,
                ws_port=ws_port, token=token, vnc_password=vnc_password,
                created_at=time.time(), pids=dict(pids),
                runtime_dir=self.runtime_dir,
            )
            self._pops[s.order_id] = pops
            self.sessions[order_id] = s
            self.tokens.add(token)
            self._write_handoff()
            return s
        except Exception:
            # clean partial spawn — never leave orphans
            for pid in pids.values():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                os.remove(pw_file)
            except OSError:
                pass
            raise

    def health(self, s: CaptchaSession) -> dict:
        pids_alive = {}
        for name, pid in s.pids.items():
            try:
                os.kill(pid, 0)
                pids_alive[name] = True
            except ProcessLookupError:
                pids_alive[name] = False
            except PermissionError:
                pids_alive[name] = True  # exists but not ours
        return {
            "order_id": s.order_id,
            "alive": all(pids_alive.values()) and not s.torn_down,
            "age_s": round(time.time() - s.created_at, 1),
            "pids_alive": pids_alive,
        }

    def teardown(self, s: CaptchaSession) -> None:
        """Kill the session's processes and invalidate its token. Idempotent."""
        if s.torn_down:
            return
        for name in ("websockify", "x11vnc", "Xvfb"):
            pid = s.pids.get(name)
            if not pid:
                continue
            # kill the whole process group (fake bins spawn children; a real
            # x11vnc also forks). Negative pid = group signal.
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    continue
        # give them a moment, then force
        deadline = time.time() + 2
        pops = self._pops.get(s.order_id, {})
        for name, pop in pops.items():
            try:
                pop.wait(timeout=2)   # reaps the child (no zombies)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(pop.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    pop.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            except ChildProcessError:
                pass
        for pid in s.pids.values():
            try:
                os.kill(pid, 0)
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                pass
        try:
            os.remove(os.path.join(self.runtime_dir, f"vncpw-{s.order_id}"))
        except OSError:
            pass
        self.tokens.discard(s.token)
        self.sessions.pop(s.order_id, None)
        self._pops.pop(s.order_id, None)
        s.torn_down = True
        self._write_handoff()

    def _write_handoff(self) -> None:
        """Persist token->ws_port for the handoff gateway (ADR-0017).

        The gateway (handoff_gateway.py) runs in its own process and needs the
        live token->port mapping; this file is the IPC. ws_host defaults to the
        manager's ws_listen so the gateway can reach websockify on the mesh.
        """
        import json as _json

        state = {
            sess.token: {"ws_port": sess.ws_port, "order_id": sess.order_id,
                         "ws_host": self.ws_listen}
            for sess in self.sessions.values()
        }
        path = os.path.join(self.runtime_dir, "handoff.json")
        os.makedirs(self.runtime_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            _json.dump(state, f)
        os.replace(tmp, path)

    def reap_stale(self) -> int:
        """Tear down sessions older than max_age_s. Returns count reaped."""
        now = time.time()
        stale = [sid for sid, s in self.sessions.items()
                 if now - s.created_at > self.max_age_s]
        for sid in stale:
            self.teardown(self.sessions[sid])
        return len(stale)


if __name__ == "__main__":
    # tiny CLI: spawn/health/teardown for manual ops
    import json
    import sys

    action = sys.argv[1] if len(sys.argv) > 1 else "spawn"
    order = sys.argv[2] if len(sys.argv) > 2 else "manual-test"
    mgr = SessionManager()
    if action == "spawn":
        s = mgr.spawn(order)
        print(s.to_json())
        print("TEARDOWN ORDER ID:", s.order_id)
    elif action == "health":
        s = mgr.sessions.get(order)
        print(json.dumps(mgr.health(s), indent=2) if s else "no session")
    elif action == "teardown":
        s = mgr.sessions.get(order)
        if s:
            mgr.teardown(s)
            print("torn down")
        else:
            print("no session")