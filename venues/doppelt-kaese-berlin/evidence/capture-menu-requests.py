#!/usr/bin/env python3
"""Record every XHR/fetch the venue's menu route makes (headed Chrome under xvfb).

WHY THIS EXISTS
---------------
The served HTML of https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase
contains ZERO prices, and the Next.js flight payload has menu items but no price
fields. The prices only exist in a client-side JSON call, so the only honest way
to find the real data source is to watch a real browser do it.

This script is the evidence for HOW the endpoint in adapter.py was found: it
prints every request the route makes and dumps the response bodies it received,
plus the text the page actually rendered (so the prices can be cross-checked
independently of the API: see `adapter.py --verify-rendered`).

RUN
---
  xvfb-run -a python3 evidence/capture-menu-requests.py --out evidence/
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright

ORDERING_URL = "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase"

# Query params whose VALUE must never be committed (analytics/telemetry keys,
# the platform's own Stripe/Adyen publishable material, session ids).
SENSITIVE_QPARAMS = ("key", "token", "secret", "sig", "signature", "password",
                     "api_key", "apikey", "auth", "session", "sid")


def sanitize(url: str) -> str:
    """Keep origin+path; drop the query if it looks like it carries a credential."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    for pair in parts.query.split("&"):
        name = pair.split("=", 1)[0].lower()
        # substring, not equality: telemetry params are namespaced ("sentry_key")
        if any(tok in name for tok in SENSITIVE_QPARAMS):
            return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return url


def keep_name(url: str):
    """Name the three calls the venue record is built from, ignore the rest."""
    if url.endswith("/api/store"):
        return "store"
    if url.endswith("/menus"):
        return "menus"
    if re.search(r"/companies/[^/]+/data(\?|$)", url):
        return "company-data"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="evidence")
    ap.add_argument("--url", default=ORDERING_URL)
    ap.add_argument("--dump-bodies", action="store_true",
                    help="also write the raw response bodies (unredacted — do NOT commit)")
    args = ap.parse_args()
    out = Path(args.out)

    rows, bodies = [], {}

    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, channel="chrome", args=["--no-sandbox"])
        ctx = b.new_context(
            locale="de-DE", timezone_id="Europe/Berlin",
            viewport={"width": 1366, "height": 2400},
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"),
        )
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        pg = ctx.new_page()

        def on_response(resp):
            if resp.request.resource_type not in ("xhr", "fetch"):
                return
            row = {"method": resp.request.method, "url": sanitize(resp.url),
                   "status": resp.status}
            rows.append(row)
            if keep_name(resp.url):
                try:
                    bodies[resp.url] = resp.body()
                except Exception as exc:  # noqa: BLE001
                    row["body_error"] = str(exc)

        pg.on("response", on_response)
        resp = pg.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(9000)
        for _ in range(12):  # let every section lazy-render
            pg.mouse.wheel(0, 2000)
            pg.wait_for_timeout(500)
        pg.wait_for_timeout(1500)

        rendered = pg.inner_text("body")
        only_venue_api = [r for r in rows if r["url"].startswith("https://app.foodamigos.io/api")
                          or "/api/" in r["url"]]
        print(f"menu route HTTP {resp.status} — {len(rows)} xhr/fetch calls "
              f"({len(only_venue_api)} to the venue/platform API)")
        for r in rows:
            print(f"  {r['status']} {r['method']} {r['url']}")

        out.mkdir(parents=True, exist_ok=True)
        (out / "rendered-ordering-page.txt").write_text(rendered, encoding="utf-8")
        (out / "requests.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8")
        for url, body in bodies.items():
            if not args.dump_bodies:
                continue
            name = keep_name(url)
            if not name:
                continue
            (out / f"live-{name}.json").write_bytes(body)
            print(f"  saved live-{name}.json  {len(body)}B  sha256={hashlib.sha256(body).hexdigest()}")
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
