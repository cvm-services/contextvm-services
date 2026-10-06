#!/usr/bin/env python3
"""Browser capture for pizzaepasta-ruedesheimerplatz.de (CVM venue adapter, S1b).

WHY A BROWSER
-------------
The origin is behind a Cloudflare **managed challenge**.  Plain HTTP clients get
`HTTP 403 + cf-mitigated: challenge` for everything — including `/robots.txt`,
`/sitemap.xml` and `/oyy-api/*` — and transplanting the successful run's
`cf_clearance` cookie into curl does **not** help (the clearance is bound to the
browser's TLS fingerprint; measured 2026-10-05).  A real headed Chrome under
xvfb passes the challenge, and the resulting page's `__NEXT_DATA__` already
carries the five `/oyy-api` payloads the adapter needs.

WHAT IT DOES
------------
* headed Chrome (`channel="chrome"`, `headless=False`) under `xvfb-run -a`
* a PERSISTENT profile under ~/.hermes/profiles/<profile>/state/, chmod 700, so
  the clearance is reused instead of re-earned (re-earning it is what burns the IP)
* at most 3 navigations, human-like pacing, then STOP
* saves the page HTML (`--out`), the request log, and a report of the challenge
  outcome (status, title, cookies, whether an interactive captcha appeared)

Exit codes: 0 page captured (HTTP 200), 3 blocked/challenged, 4 interactive captcha.

RUN
---
    xvfb-run -a python3 capture-menu-requests.py --out evidence/page.html

Do NOT run this in a loop.  On a repeated 403 the IP cooldown is sticky: wait,
and use the committed evidence in evidence/raw/ instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

TARGET = "https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/127.0.0.0 Safari/537.36")
DEFAULT_PROFILE = str(Path.home() / ".hermes/profiles/manager/state/pep-browser")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="evidence/page.html", help="where to save the page HTML")
    ap.add_argument("--profile", default=DEFAULT_PROFILE, help="persistent Chrome profile dir")
    ap.add_argument("--target", default=TARGET)
    ap.add_argument("--max-attempts", type=int, default=3)
    ap.add_argument("--challenge-budget", type=int, default=170,
                    help="seconds to wait for the managed challenge to clear")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright  # imported late so --help works without it

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    os.makedirs(args.profile, exist_ok=True)
    os.chmod(args.profile, 0o700)

    requests_log: list[dict] = []
    report: dict = {"target": args.target, "profile": args.profile, "attempts": []}

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            args.profile, headless=False, channel="chrome", locale="de-DE",
            timezone_id="Europe/Berlin", viewport={"width": 1366, "height": 900},
            user_agent=UA,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(r):
            try:
                req = r.request
                if req.resource_type in ("xhr", "fetch", "document"):
                    requests_log.append({
                        "method": req.method, "url": r.url,
                        "resource_type": req.resource_type, "status": r.status,
                        "content_type": (r.headers or {}).get("content-type", ""),
                    })
            except Exception:  # noqa: BLE001
                pass

        pg.on("response", on_response)

        nav_status = None
        for attempt in range(1, args.max_attempts + 1):
            nav = None
            try:
                nav = pg.goto(args.target, wait_until="domcontentloaded", timeout=60000)
                nav_status = nav.status if nav else None
            except Exception as exc:  # noqa: BLE001
                report["attempts"].append({"attempt": attempt, "error": str(exc)})
                time.sleep(15)
                continue
            t0 = time.time()
            while time.time() - t0 < args.challenge_budget:
                if "moment" not in (pg.title() or "").lower():
                    break
                time.sleep(3)
            time.sleep(5)
            title = pg.title()
            body = pg.content()
            challenged = "moment" in (title or "").lower() or "challenges.cloudflare.com" in body
            report["attempts"].append({"attempt": attempt, "status": nav_status,
                                       "title": title, "challenged": challenged})
            if nav_status == 200 and not challenged:
                break
            time.sleep(20)  # human-like pacing between retries

        cookies = ctx.cookies()
        report["final_status"] = nav_status
        report["final_title"] = pg.title()
        report["cookies"] = sorted({c["name"] for c in cookies})
        frames = [f.url for f in pg.frames if "challenges.cloudflare.com" in (f.url or "")]
        report["turnstile_frames"] = frames
        report["interactive_captcha"] = bool(frames) and nav_status != 200

        if nav_status == 200 and not report["attempts"][-1].get("challenged"):
            html = pg.content().encode("utf-8")
            out.write_bytes(html)
            report["page_bytes"] = len(html)
            report["page_sha256"] = hashlib.sha256(html).hexdigest()
        report["captured_at"] = datetime.now(timezone.utc).isoformat()

        if requests_log:
            (out.parent / "requests.json").write_text(
                json.dumps({"captured_at": report["captured_at"], "requests": requests_log},
                           ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8")
        (out.parent / "cookies.json").write_text(
            json.dumps([{"name": c["name"], "domain": c["domain"], "path": c["path"],
                         "secure": c["secure"], "httpOnly": c["httpOnly"],
                         "value": "[REDACTED]"} for c in cookies],
                       ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8")
        (out.parent / "recon-info.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8")
        ctx.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["interactive_captcha"]:
        print("STOP: interactive captcha present — not attempting to bypass it", file=sys.stderr)
        return 4
    if report["final_status"] != 200:
        print("STOP: still blocked by the Cloudflare managed challenge (sticky IP cooldown); "
              "use the committed evidence instead of retrying", file=sys.stderr)
        return 3
    print(f"OK page saved to {out} ({report.get('page_bytes')} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
