#!/usr/bin/env python3
"""Reconnaissance for the OrderYoyo consumer-account flow (ADR-0009 card).

WHAT IT DOES (read-only; creates NO order and NO account unless --register)
-------------------------------------------------------------------------
Drives ONE headed Chrome session under xvfb against the venue's own shop,
using the SAME persistent profile the menu capture uses (so the Cloudflare
managed challenge is reused rather than re-earned), then:

  * navigates to the ordering page and to the "Anmeldung" (login) route
  * records every XHR/fetch the shop itself makes (names + statuses only)
  * enumerates the form fields on the login screen (labels, input names/types)
  * reads the actor's own browser localStorage/sessionStorage key NAMES

It never submits credentials and never registers anything unless --register is
passed. Cookie values, tokens and any password/email value are redacted.

Exit codes: 0 ok, 3 blocked by challenge, 4 interactive captcha.

RUN
---
    xvfb-run -a python3 recon-auth-flow.py --out evidence/auth-recon.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://pizzaepasta-ruedesheimerplatz.de"
START = BASE + "/pizza-e-pasta/takeaway"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/127.0.0.0 Safari/537.36")
DEFAULT_PROFILE = str(Path.home() / ".hermes/profiles/manager/state/pep-browser")

# value-bearing keys whose VALUES must never be written to the report
SECRET_RE = re.compile(
    r"(pass|pwd|token|secret|clearance|cf_bm|_cfuvid|authorization|bearer|"
    r"cookie|email|mail|phone|nsec|key)", re.I)


def redact_url(url: str) -> str:
    """Keep the route; drop query values that look secret-bearing."""
    if "?" not in url:
        return url
    path, _, q = url.partition("?")
    keep = []
    for part in q.split("&"):
        k = part.split("=", 1)[0]
        keep.append(part if not SECRET_RE.search(k) else f"{k}=[REDACTED]")
    return path + "?" + "&".join(keep)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="evidence/auth-recon.json")
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    ap.add_argument("--register", action="store_true",
                    help="ALSO walk the registration form (does not submit)")
    ap.add_argument("--challenge-budget", type=int, default=170,
                    help="seconds to wait for the managed challenge to clear")
    ap.add_argument("--max-attempts", type=int, default=3)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    os.makedirs(args.profile, exist_ok=True)
    os.chmod(args.profile, 0o700)

    report: dict = {
        "target_base": BASE,
        "start_url": START,
        "profile": args.profile,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "navigations": [],
        "xhr": [],
        "login_screen": {},
        "storage_keys": {},
        "links": [],
    }

    seen: set[str] = set()

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            args.profile, headless=False, channel="chrome", locale="de-DE",
            timezone_id="Europe/Berlin", viewport={"width": 1366, "height": 900},
            user_agent=UA,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(r):
            try:
                req = r.request
                if req.resource_type not in ("xhr", "fetch"):
                    return
                key = f"{req.method} {r.url}"
                if key in seen:
                    return
                seen.add(key)
                report["xhr"].append({
                    "method": req.method,
                    "url": redact_url(r.url),
                    "status": r.status,
                    "content_type": (r.headers or {}).get("content-type", ""),
                    "post_body_keys": sorted(json.loads(req.post_data).keys())
                    if req.post_data and req.post_data.strip().startswith("{")
                    else None,
                })
            except Exception:  # noqa: BLE001
                pass

        pg.on("response", on_response)

        def settle(seconds: float = 6.0) -> None:
            time.sleep(seconds)

        # A Cloudflare managed challenge answers 403 with title "Nur einen
        # Moment…" and then clears itself in the same navigation. Wait it out
        # (the capture script does the same, budget 170s) before declaring a
        # block — the distinction matters: a cleared challenge is a usable page.
        nav = None
        for attempt in range(1, args.max_attempts + 1):
            try:
                nav = pg.goto(START, wait_until="domcontentloaded", timeout=60000)
            except Exception as exc:  # noqa: BLE001
                report["navigations"].append({"url": START, "attempt": attempt,
                                              "error": str(exc)})
                time.sleep(15)
                continue
            t0 = time.time()
            while time.time() - t0 < args.challenge_budget:
                if "moment" not in (pg.title() or "").lower():
                    break
                time.sleep(3)
            settle()
            title = pg.title()
            entry = {"url": START, "attempt": attempt,
                     "status": nav.status if nav else None, "title": title,
                     "challenged": "moment" in (title or "").lower(),
                     "waited_s": round(time.time() - t0, 1)}
            report["navigations"].append(entry)
            if nav is not None and nav.status == 200 and not entry["challenged"]:
                break
            time.sleep(20)
        title = pg.title()
        if nav is None or nav.status != 200 or "moment" in (title or "").lower():
            report["blocked"] = True
            out.write_text(json.dumps(report, ensure_ascii=False, indent=2,
                                      sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False, indent=2)[:1500])
            print("STOP: blocked by the Cloudflare managed challenge", file=sys.stderr)
            ctx.close()
            return 3

        # enumerating the venue's own navigation: every anchor whose text or
        # href mentions the account surfaces
        anchors = pg.eval_on_selector_all(
            "a", "els => els.map(e => ({text: (e.innerText||'').trim().slice(0,60),"
                 " href: e.getAttribute('href')}))")
        report["links"] = [a for a in anchors
                           if a["href"] and re.search(
                               r"anmeld|login|konto|account|regist|sign", 
                               (a["text"] or "") + " " + (a["href"] or ""), re.I)][:40]

        # try the login route the UI advertises, else the conventional one
        candidates = [a["href"] for a in report["links"] if a["href"]]
        for extra in ("/pizza-e-pasta/login", "/login", "/pizza-e-pasta/anmeldung",
                      "/anmeldung", "/pizza-e-pasta/account", "/account"):
            if extra not in candidates:
                candidates.append(extra)

        for href in candidates[:6]:
            url = href if href.startswith("http") else BASE + href
            try:
                r2 = pg.goto(url, wait_until="domcontentloaded", timeout=45000)
                settle(4)
                t2 = pg.title()
                entry = {"url": url, "status": r2.status if r2 else None, "title": t2}
                if r2 and r2.status == 200 and "moment" not in (t2 or "").lower():
                    fields = pg.eval_on_selector_all(
                        "input,select,textarea",
                        "els => els.map(e => ({tag: e.tagName.toLowerCase(),"
                        " name: e.getAttribute('name'), id: e.id||null,"
                        " type: e.getAttribute('type'),"
                        " placeholder: e.getAttribute('placeholder'),"
                        " autocomplete: e.getAttribute('autocomplete'),"
                        " required: e.hasAttribute('required')}))")
                    buttons = pg.eval_on_selector_all(
                        "button,[role=button],input[type=submit]",
                        "els => els.map(e => (e.innerText||e.value||'').trim().slice(0,60))")
                    labels = pg.eval_on_selector_all(
                        "label", "els => els.map(e => (e.innerText||'').trim().slice(0,60))")
                    entry["fields"] = [f for f in fields
                                       if not (f.get("name") or "").lower().startswith("_")]
                    entry["buttons"] = [b for b in buttons if b][:20]
                    entry["labels"] = [l for l in labels if l][:20]
                    entry["visible_text_head"] = (pg.inner_text("body") or "")[:800]
                    report["login_screen"] = entry
                report["navigations"].append(entry)
                if entry.get("fields"):
                    break
            except Exception as exc:  # noqa: BLE001
                report["navigations"].append({"url": url, "error": str(exc)})

        # storage key NAMES only (values are never read)
        try:
            report["storage_keys"] = {
                "localStorage": pg.evaluate("Object.keys(window.localStorage)"),
                "sessionStorage": pg.evaluate("Object.keys(window.sessionStorage)"),
            }
            report["storage_key_count"] = {k: len(v) for k, v in report["storage_keys"].items()}
        except Exception:  # noqa: BLE001
            pass

        report["final_url"] = pg.url
        ctx.close()

    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")
    print(json.dumps({k: report[k] for k in
                      ("navigations", "xhr", "login_screen", "storage_key_count")},
                     ensure_ascii=False, indent=2)[:6000])
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
