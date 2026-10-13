#!/usr/bin/env python3
"""Walk the 2fiat top-up to the point where the app produces a Lightning invoice.

SAFE BY DESIGN: creating a top-up quote produces an invoice for US to pay. It
moves no money — no card is charged, no purchase is made. The script stops the
moment an invoice/QR appears and never confirms a purchase.

  TWO_FIAT_TOKEN=<...> ~/.cache/pw-venv/bin/python 2fiat_topup_quote.py
"""
from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

TOKEN = os.environ.get("TWO_FIAT_TOKEN", "")
OUT = "/tmp/2fiat-topup-quote.json"
AMOUNT = os.environ.get("TOPUP_AMOUNT", "10")

# Hard stop: never click anything that buys, confirms a purchase or pays.
FORBIDDEN = ("confirm", "buy now", "purchase", "pay now", "place order", "submit payment")


def main() -> int:
    if not TOKEN:
        print("TWO_FIAT_TOKEN not set", file=sys.stderr)
        return 2

    calls: list[dict] = []
    steps: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 1200},
        )
        page = ctx.new_page()

        def record(r):
            if "/api/" in r.url:
                calls.append({
                    "method": r.method,
                    "url": r.url.replace(TOKEN, "<TOKEN>"),
                    "body": (r.post_data or "")[:600].replace(TOKEN, "<TOKEN>"),
                    "response_status": None,
                })
        page.on("request", record)

        # The top-up POST's RESPONSE is the contract we need: it carries the
        # Lightning invoice and/or the quote id. Capture the body (truncated).
        def on_response(r):
            if "topup" in r.url and "/api/" in r.url:
                try:
                    text = r.text()
                except Exception:
                    text = "<unreadable>"
                calls.append({
                    "method": r.request.method,
                    "url": r.url.replace(TOKEN, "<TOKEN>"),
                    "body": "",
                    "response_status": r.status,
                    "response_body": text[:1500].replace(TOKEN, "<TOKEN>"),
                })
        page.on("response", on_response)

        page.goto(f"https://2fiat.com/wallet/{TOKEN}/my-cards", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)

        # Open the first card.
        try:
            page.get_by_text("5257", exact=False).first.click(timeout=8000)
            page.wait_for_timeout(3500)
            steps.append("opened first card")
        except Exception as e:
            steps.append(f"could not open card: {str(e)[:60]}")

        # Fill the Top-up amount field. It is the input whose placeholder is 1000
        # and which sits in the Top-up control (the Transfer field is its sibling).
        # React ignores a plain `.value = x`; the NATIVE setter must be used so
        # React's onChange sees the change. Without this the app never receives
        # the amount and no top-up request is ever made (learned the hard way).
        filled = page.evaluate(
            """(amount) => {
                const inputs = [...document.querySelectorAll('input')]
                    .filter(e => e.offsetParent !== null);
                const el = inputs[0];
                if (!el) return {ok: false, why: 'no input'};
                const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value').set;
                el.focus();
                setter.call(el, '');
                el.dispatchEvent(new Event('input', {bubbles: true}));
                setter.call(el, String(amount));
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
                el.dispatchEvent(new Event('blur', {bubbles: true}));
                return {ok: true, placeholder: el.placeholder, value: el.value};
            }""",
            AMOUNT,
        )
        steps.append(f"filled top-up amount {AMOUNT}: {filled}")
        page.wait_for_timeout(1000)

        # The amount reveals the RAIL selector (BTC LN / XMR / BTC / Altcoins).
        # Choose Lightning explicitly — that is the rail our melt pays into.
        try:
            page.get_by_text("BTC LN", exact=True).first.click(timeout=8000)
            page.wait_for_timeout(4000)
            steps.append("selected rail BTC LN")
        except Exception as e:
            steps.append(f"rail click failed: {str(e)[:60]}")

        # Proceed with Enter (a text field's own submit); never a purchase control.
        page.keyboard.press("Enter")
        page.wait_for_timeout(5000)
        after_enter = page.evaluate(
            """() => ['BTC LN','Lightning'].filter(r => document.body.innerText.includes(r))"""
        )
        steps.append(f"rails still shown after Enter: {after_enter}")

        # Anything new on screen? An invoice, a QR, a rail chooser, or a button.
        state = page.evaluate(
            """() => {
                const txt = document.body.innerText;
                const vis = (e) => e.offsetParent !== null;
                return {
                    buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis)
                        .map(e => e.innerText.trim().slice(0, 40)).filter(Boolean),
                    invoiceLike: (txt.match(/lnbc[0-9a-z]+/i) || [])[0] || null,
                    hasQR: !!document.querySelector('svg[viewBox], canvas, img[src*=qr i]'),
                    rails: ['BTC LN','Lightning','BTC-LN','XMR','Altcoins'].filter(r => txt.includes(r)),
                    bodySample: txt.slice(0, 1400),
                };
            }"""
        )
        page.screenshot(path="/tmp/2fiat-topup-quote.png", full_page=True)
        browser.close()

    topup_calls = [c for c in calls if "/topup" in c["url"] or "topup" in c["url"].lower()]
    report = {"steps": steps, "amount": AMOUNT, "state": state,
              "topup_api_calls": topup_calls, "all_api_calls": calls}
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({"steps": steps, "topup_api_calls": topup_calls,
                      "invoice_like": state["invoiceLike"], "hasQR": state["hasQR"],
                      "rails": state["rails"], "buttons": state["buttons"]}, indent=2)[:3000])
    print("\nbody sample:\n", state["bodySample"][:900])
    print(f"\nfull report: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
