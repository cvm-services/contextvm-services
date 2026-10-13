#!/usr/bin/env python3
"""Map the Three Buddies checkout: required fields, payment rails, and the API
contract — WITHOUT placing an order and WITHOUT entering card data.

Why: the facilitator console can only hand off to this checkout if we know
exactly what it demands (name, email, mandatory phone, SMS verification) and
which API endpoints the form drives. This walks the flow to the payment step and
STOPS. It never clicks a submit/pay control, never types a card number.

  ~/.cache/pw-venv/bin/python threebuddies_checkout_recon.py
"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

VENUE = "https://www.threebuddies.de/speisekarte/threebuddies"
OUT = "/tmp/threebuddies-checkout.json"

# Never click these — placing an order costs the venue real work.
FORBIDDEN = ("jetzt bestellen", "bestellen", "zahlungspflichtig", "bezahlen",
             "pay", "submit", "order now", "place order", "kostenpflichtig")


def main() -> int:
    calls: list[dict] = []
    steps: list[str] = []
    blocked: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            viewport={"width": 1400, "height": 1200}, locale="de-DE",
        )
        page = ctx.new_page()

        def record(req):
            u = req.url
            # Only the venue's own + its platform API. Stripe telemetry (r.stripe.com/b)
            # and Google logging are noise, and card data never transits us.
            if ("foodamigos" in u or "threebuddies" in u) and "/api/" in u:
                calls.append({
                    "method": req.method, "url": u,
                    "body": (req.post_data or "")[:600],
                })
        page.on("request", record)

        page.goto(VENUE, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(7000)
        steps.append("loaded venue ordering page")

        # The user's own flow: add the Capri Sun, then open the cart.
        added = False
        try:
            page.get_by_text("Capri Sun", exact=False).first.click(timeout=8000)
            page.wait_for_timeout(2500)
            steps.append("opened the Capri Sun product sheet")
            # An add-to-cart control on the sheet (not a checkout control).
            for label in ("Hinzufügen", "In den Warenkorb", "Add", "hinzufügen"):
                try:
                    el = page.get_by_text(label, exact=False).first
                    if el.is_visible():
                        el.click(timeout=4000)
                        added = True
                        steps.append(f"added to cart via {label!r}")
                        break
                except Exception:
                    continue
            if not added:
                steps.append("no add-to-cart control found on the sheet")
        except Exception as e:
            steps.append(f"could not open the product: {str(e)[:60]}")

        page.wait_for_timeout(2000)
        # Open the cart / checkout view (safe: it does not pay).
        for label in ("Warenkorb", "Zur Kasse", "Kasse"):
            try:
                el = page.get_by_text(label, exact=False).first
                if el.is_visible():
                    el.click(timeout=4000)
                    page.wait_for_timeout(4000)
                    steps.append(f"opened {label!r}")
                    break
            except Exception:
                continue

        # Enumerate everything the checkout demands.
        form = page.evaluate(
            """() => {
                const vis = (e) => e.offsetParent !== null;
                const inputs = [...document.querySelectorAll('input,select,textarea')]
                    .filter(vis).map(e => ({
                        tag: e.tagName, type: e.type, name: e.name, id: e.id,
                        placeholder: e.placeholder, required: e.required,
                        autocomplete: e.autocomplete,
                        inIframe: false,
                    }));
                // Stripe Elements live in cross-origin iframes — detect them,
                // because that is where CARD DATA goes and it is not ours.
                const iframes = [...document.querySelectorAll('iframe')]
                    .filter(vis).map(f => ({
                        src: (f.src || '').slice(0, 120), name: f.name, title: f.title,
                    })).filter(f => f.src || f.title);
                const txt = document.body.innerText;
                return {
                    inputs, iframes,
                    requiredMarkers: [...document.querySelectorAll('[required],[aria-required=true]')]
                        .filter(vis).map(e => e.name || e.id || e.placeholder || e.tagName).slice(0, 20),
                    rails: ['Kartenzahlung','Cash','Bar','PayPal','Visa','MasterCard','Apple Pay','Google Pay']
                        .filter(r => txt.includes(r)),
                    mentionsSms: /sms|verifizieren|Telefonnummer/i.test(txt),
                    bodySample: txt.slice(0, 1200),
                };
            }"""
        )
        page.screenshot(path="/tmp/threebuddies-checkout.png", full_page=True)
        browser.close()

    report = {"steps": steps, "blocked": blocked, "form": form, "api_calls": calls}
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({
        "steps": steps,
        "required_markers": form["requiredMarkers"],
        "rails": form["rails"],
        "mentionsSms": form["mentionsSms"],
        "inputs": form["inputs"][:18],
        "iframes": form["iframes"][:8],
        "api_calls": calls[-14:],
    }, indent=2)[:4200])
    print(f"\nfull report: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
