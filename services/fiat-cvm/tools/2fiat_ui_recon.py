#!/usr/bin/env python3
"""Playwright recon of the real 2fiat.com wallet UI: what can a user actually DO?

Goal: determine how money moves IN (top-up) and OUT (paying a merchant), and
whether either has an API we can drive. Records the XHR/fetch calls the app
itself makes — that is the honest way to learn the API, since the API is
whatever the UI calls.

Careful by design: ONE browser, human-like pacing, no request bursts (a burst
tripped their edge limiter twice already).

  ~/.cache/pw-venv/bin/python 2fiat_ui_recon.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

# The wallet login token comes from the environment — never hardcoded, never
# printed. Loaded by the caller from OpenBao.
TOKEN = __import__("os").environ.get("TWO_FIAT_TOKEN", "")
OUT = "/tmp/2fiat-recon.json"


def main() -> int:
    if not TOKEN:
        print("TWO_FIAT_TOKEN not set", file=sys.stderr)
        return 2

    calls: list[dict] = []
    console: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 1000},
        )
        page = ctx.new_page()

        # Learn the API from what the app itself calls.
        def on_request(req):
            if "/api/" in req.url:
                calls.append({"method": req.method, "url": req.url.replace(TOKEN, "<TOKEN>"),
                              "body": (req.post_data or "")[:400].replace(TOKEN, "<TOKEN>")})

        page.on("request", on_request)
        page.on("console", lambda m: console.append(f"{m.type}: {m.text[:160]}") if m.type == "error" else None)

        url = f"https://2fiat.com/wallet/{TOKEN}/my-cards"
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)

        # What is on the page? Every affordance a user could click.
        snapshot = page.evaluate(
            """() => {
                const txt = (el) => (el.innerText || el.value || '').trim().slice(0, 60);
                const visible = (el) => el.offsetParent !== null || el.tagName === 'BODY';
                const buttons = [...document.querySelectorAll('button, a[href], [role=button], input[type=submit]')]
                    .filter(visible).map(txt).filter(Boolean);
                const navs = [...document.querySelectorAll('nav a, [class*=nav] a, [class*=sidebar] a')]
                    .filter(visible).map(e => ({text: txt(e), href: e.getAttribute('href')}));
                return {
                    title: document.title,
                    headings: [...document.querySelectorAll('h1,h2,h3')].map(txt).filter(Boolean).slice(0, 12),
                    buttons: [...new Set(buttons)].slice(0, 40),
                    navs,
                    hasCards: /card/i.test(document.body.innerText),
                    bodySample: document.body.innerText.slice(0, 900),
                };
            }"""
        )

        page.screenshot(path="/tmp/2fiat-wallet.png", full_page=True)
        browser.close()

    report = {"url_path": "/wallet/<TOKEN>/my-cards", "ui": snapshot, "api_calls": calls, "console_errors": console[:8]}
    print(json.dumps(report, indent=2)[:5000])
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nfull report: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
