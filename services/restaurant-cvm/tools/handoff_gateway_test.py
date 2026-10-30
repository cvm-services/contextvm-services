"""Handoff gateway: token scoping, static resolution, handoff parsing."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _mod():
    spec = importlib.util.spec_from_file_location(
        "handoff_gateway", HERE / "handoff_gateway.py")
    m = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(m)
    return m


g = _mod()


class TestParse(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(g.parse_view_path("/venue/view/tok123/vnc.html"),
                         ("tok123", "vnc.html"))
        self.assertEqual(g.parse_view_path("/venue/view/tok123/"),
                         ("tok123", ""))
        self.assertEqual(g.parse_view_path("/venue/view/tok123"),
                         ("tok123", ""))  # bare token path redirects

    def test_not_a_view(self):
        self.assertIsNone(g.parse_view_path("/lnurlp/facilitator"))
        self.assertIsNone(g.parse_view_path("/venue/view/"))
        self.assertIsNone(g.parse_view_path("/venue/viewx/tok/a"))


class TestStatic(unittest.TestCase):
    def test_resolves_under_root(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "vnc.html").write_text("x")
            self.assertEqual(g.resolve_static(root, "vnc.html"),
                             (root / "vnc.html").resolve())
            self.assertEqual(g.resolve_static(root, ""),
                             (root / "vnc.html").resolve())

    def test_refuses_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            root.mkdir()
            (Path(d) / "secret").write_text("nope")
            self.assertIsNone(g.resolve_static(root, "../secret"))
            self.assertIsNone(g.resolve_static(root, "%2e%2e/secret"))

    def test_missing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(g.resolve_static(Path(d), "nope.js"))


class TestHandoff(unittest.TestCase):
    def test_find_session(self):
        h = {"a" * 32: {"ws_port": 49000}}
        self.assertEqual(g.find_session("a" * 32, h)["ws_port"], 49000)
        self.assertIsNone(g.find_session("b" * 32, h))
        self.assertIsNone(g.find_session("", h))

    def test_bad_file_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "handoff.json"
            p.write_text("{not json")
            self.assertEqual(g.load_handoff(p), {})
            p.write_text(json.dumps({"tok": {"ws_port": "not-int"}}))
            self.assertEqual(g.load_handoff(p), {})


if __name__ == "__main__":
    unittest.main()


class TestBareVnc(unittest.TestCase):
    def test_bare_vnc_needs_the_query(self):
        self.assertTrue(g.needs_vnc_redirect("vnc.html", ""))
        self.assertTrue(g.needs_vnc_redirect("", ""))
        self.assertFalse(g.needs_vnc_redirect(
            "vnc.html", "autoconnect=1&path=venue/view/t/websockify"))

    def test_other_files_are_not_redirected(self):
        self.assertFalse(g.needs_vnc_redirect("core/rfb.js", ""))
        self.assertFalse(g.needs_vnc_redirect("app/ui.js", "x=1"))
