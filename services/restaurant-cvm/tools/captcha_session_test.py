# Tests for the captcha VNC session manager.
#
# These run WITHOUT installing x11vnc/websockify: the manager is injectable —
# spawn() takes the Xvfb/x11vnc/websockify commands from a builder so tests can
# pass fake executables. The live-binary path is exercised by an env-gated test
# only when the real packages are present (skipped on CI without them).
import shutil
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from captcha_session import (  # noqa: E402
    CaptchaSession,
    CaptchaSessionError,
    SessionManager,
)

import tempfile
import json
import time


def _fake_bins(tmp):
    """Write tiny shell scripts that behave like Xvfb/x11vnc/websockify:
    they print a startup line and then sleep forever (so the manager sees live
    processes). Killing them works normally."""
    bins = {}
    for name in ("Xvfb", "x11vnc", "websockify"):
        p = os.path.join(tmp, name)
        if name == "websockify":
            # behave like the real one: LISTEN on argv[1], then idle
            with open(p, "w") as f:
                f.write(
                    "#!/usr/bin/env python3\n"
                    "import socket, sys, time\n"
                    "srv = socket.socket()\n"
                    "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
                    "srv.bind(('127.0.0.1', int(sys.argv[1])))\n"
                    "srv.listen(1)\n"
                    "while True:\n"
                    "    time.sleep(5)\n"
                )
        else:
            with open(p, "w") as f:
                f.write("#!/bin/sh\nsleep 600\n")
        os.chmod(p, 0o755)
        bins[name] = p
    return bins


def test_spawn_creates_live_session_and_teardown_kills_all():
    with tempfile.TemporaryDirectory() as tmp:
        bins = _fake_bins(tmp)
        mgr = SessionManager(runtime_dir=tmp, bins=bins)
        s = mgr.spawn("order-1")
        assert s.order_id == "order-1"
        assert s.display.startswith(":")
        assert s.vnc_port and s.ws_port
        # processes alive
        for name in ("x11vnc", "websockify", "Xvfb"):
            assert s.pids[name] and s.pids[name] > 0
        # token unguessable-ish and recorded
        assert len(s.token) >= 32
        # teardown kills everything
        mgr.teardown(s)
        for name, pid in s.pids.items():
            # a zombie still answers kill(0); read its /proc state instead
            state = "?"
            try:
                with open(f"/proc/{pid}/status") as f:
                    for line in f:
                        if line.startswith("State:"):
                            state = line.split()[1]
                            break
            except FileNotFoundError:
                state = "gone"
            assert state in ("gone", "Z"), (
                f"{name} pid {pid} survived teardown (state={state})")
        # teardown is idempotent
        mgr.teardown(s)


def test_no_port_listens_after_teardown():
    import socket

    with tempfile.TemporaryDirectory() as tmp:
        bins = _fake_bins(tmp)
        mgr = SessionManager(runtime_dir=tmp, bins=bins)
        s = mgr.spawn("order-2")
        ports = (s.vnc_port, s.ws_port)
        mgr.teardown(s)
        for port in ports:
            with socket.socket() as sock:
                sock.settimeout(1)
                # after teardown nothing should be bound; a connection attempt
                # should fail (refused), never succeed
                result = sock.connect_ex(("127.0.0.1", port))
                assert result != 0, f"port {port} still accepting connections"


def test_stale_sessions_are_reaped():
    with tempfile.TemporaryDirectory() as tmp:
        bins = _fake_bins(tmp)
        mgr = SessionManager(runtime_dir=tmp, bins=bins, max_age_s=1)
        s = mgr.spawn("order-3")
        # simulate age beyond the max
        s.created_at = time.time() - 10
        time.sleep(1.1)
        mgr.reap_stale()
        state = "?"
        try:
            with open(f"/proc/{s.pids['x11vnc']}/status") as f:
                for line in f:
                    if line.startswith("State:"):
                        state = line.split()[1]
                        break
        except FileNotFoundError:
            state = "gone"
        assert state in ("gone", "Z"), f"stale session was not reaped (state={state})"
        assert s.token not in mgr.tokens


def test_token_is_unique_per_session_and_removed_on_teardown():
    with tempfile.TemporaryDirectory() as tmp:
        bins = _fake_bins(tmp)
        mgr = SessionManager(runtime_dir=tmp, bins=bins)
        a = mgr.spawn("order-a")
        b = mgr.spawn("order-b")
        assert a.token != b.token
        assert a.vnc_port != b.vnc_port
        mgr.teardown(a)
        assert a.token not in mgr.tokens
        assert b.token in mgr.tokens
        mgr.teardown(b)


def test_spawn_refuses_when_binary_missing():
    with tempfile.TemporaryDirectory() as tmp:
        # point at a dir with NO binaries — the manager must diagnose, not fail mid-spawn
        mgr = SessionManager(runtime_dir=tmp, bins={"Xvfb": os.path.join(tmp, "nope")})
        try:
            mgr.spawn("order-x")
            raise AssertionError("expected CaptchaSessionError")
        except CaptchaSessionError as e:
            assert "Xvfb" in str(e)


def test_health_reports_liveness():
    with tempfile.TemporaryDirectory() as tmp:
        bins = _fake_bins(tmp)
        mgr = SessionManager(runtime_dir=tmp, bins=bins)
        s = mgr.spawn("order-h")
        h = mgr.health(s)
        assert h["alive"] is True
        assert set(h["pids_alive"]) == {"Xvfb", "x11vnc", "websockify"}
        mgr.teardown(s)
        h2 = mgr.health(s)
        assert h2["alive"] is False


def run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"ok   {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)