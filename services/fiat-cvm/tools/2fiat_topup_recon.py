#!/usr/bin/env python3
"""Drive the 2fiat top-up flow as a USER and record the API calls it makes.

This is how the API is legitimately learned: the UI's own XHR calls ARE the
contract. The script stops BEFORE any confirmation — it never spends, never
buys a card, never submits a payment. It walks to the point where the app shows
a Lightning invoice (or a confirm button) and stops there.

  TWO_FIAT_TOKEN=<...> ~/.cache/pw-venv/bin/python 2fiat_topup_recon.py
"""
from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

TOKEN = os.environ.get("TWO_FIAT_TOKEN", "")
OUT = "/tmp/2fiat-topup-recon.json"

# Anything that could spend money. Last line of defence: if a click's target
# matches this, the script refuses instead of acting.
SPENDY = ("confirm", "buy now", "purchase", "pay now", "submit payment", "place order")


def main() -> int:
    if not TOKEN:
        print("TWO_FIAT_TOKEN not set", file=sys.stderr)
        return 2

    calls: list[dict] = []
    steps: list[str] = []
    refused: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 1200},
        )
        page = ctx.new_page()
        page.on("request", lambda r: calls.append({
            "method": r.method,
            "url": r.url.replace(TOKEN, "<TOKEN>"),
            "body": (r.post_data or "")[:500].replace(TOKEN, "<TOKEN>"),
        }) if "/api/" in r.url else None)

        page.goto(f"https://2fiat.com/wallet/{TOKEN}/my-cards", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)
        steps.append("loaded My Cards")

        def find_and_click(labels, note, skip_spendy=True):
            """Click the first visible control whose text matches. Never a spendy one."""
            for label in labels:
                try:
                    el = page.get_by_text(label, exact=False).first
                    if el and el.is_visible():
                        text = (el.inner_text() or "").strip().lower()
                        if skip_spendy and any(s in text for s in SPENDY):
                            refused.append(f"{note}: refused spendy target {text!r}")
                            return False
                        el.click(timeout=5000)
                        page.wait_for_timeout(3500)
                        steps.append(f"{note} (clicked {label!r})")
                        return True
                except Exception:
                    continue
            return False

        # 1. Open the top-up flow for the FIRST card.
        before = len(calls)
        find_and_click(["Top-up", "Top Up", "Top up"], "open top-up")
        # 2. If a card chooser appears, take the first card.
        if len(calls) == before:
            find_and_click(["5257"], "select first card")
        # 3. Look for the rail selector and any amount field.
        ui = page.evaluate(
            """() => {
                const vis = (e) => e.offsetParent !== null;
                return {
                    bodySample: document.body.innerText.slice(0, 1200),
                    inputs: [...document.querySelectorAll('input,select,textarea')].filter(vis)
                        .map(e => ({tag: e.tagName, type: e.type, name: e.name, placeholder: e.placeholder,
                                    options: e.tagName === 'SELECT' ? [...e.options].map(o => o.text.slice(0,30)) : undefined})),
                    buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis)
                        .map(e => e.innerText.trim().slice(0, 40)).filter(Boolean),
                    links: [...document.querySelectorAll('a[href]')].filter(vis)
                        .map(e => ({t: e.innerText.trim().slice(0,30), h: e.getAttribute('href')})).slice(0,20),
                };
            }"""
        )
        page.screenshot(path="/tmp/2fiat-topup.png", full_page=True)

        # 4. Read the page for the top-up rail names (BTC LN is the one that matters).
        rails = page.evaluate(
            """() => {
                const txt = document.body.innerText;
                return ['BTC LN','Lightning','BTC-LN','XMR','Altcoins'].filter(r => txt.includes(r));
            }"""
        )
        browser.close()

    report = {"steps": steps, "refused_spendy": refused, "rails_visible": rails,
              "ui": ui, "api_calls": calls}
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({"steps": steps, "refused_spendy": refused, "rails_visible": rails,
                      "buttons": ui["buttons"], "inputs": ui["inputs"], "links": ui["links"],
                      "api_calls": calls}, indent=2)[:4000])
    print(f"\nfull report: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
