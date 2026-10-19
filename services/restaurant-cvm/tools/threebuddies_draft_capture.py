#!/usr/bin/env python3
"""R2: capture the storefront's OWN `POST /order-drafts` body.

The contract is fully known EXCEPT one field: `order-drafts` still answers 500 even
with a genuine `product_id` from `/api/companies/550/menus` (122 products, keyed by
exactly the id family our venue records carry). So the missing piece is a FIELD we
are not sending, and the only authoritative source for it is the storefront's own
request. The UI's calls ARE the contract.

WHAT THE EARLIER ATTEMPT GOT WRONG (measured, see docs/r2-order-drafts-contract.md):
  1. a cookie-consent banner blocks the page (`AKZEPTIEREN`),
  2. the landing page is NOT the ordering surface — it is `/speisekarte/threebuddies`,
  3. a keyword sweep for "add"/"+" finds nothing: the controls are rendered by the
     app's own component tree after hydration.

OBSERVATION ONLY. Never enters payment, never types card data (card fields are Stripe
cross-origin iframes), never clicks anything matching a spend verb. The card/payment
leg is out of scope for R2 entirely (submit: false; the human holds payment
authority). One page load, bounded clicks — the host is rate-limit sensitive.
"""

from __future__ import annotations

import json
import os
import re
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("run with ~/.cache/pw-venv/bin/python", file=sys.stderr)
    raise SystemExit(3)

STORE = "https://threebuddies.foodamigos-storefront.com"
ORDER_URL = f"{STORE}/speisekarte/threebuddies"
OUT = "/tmp/r2-drafts.json"

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# A payment verb here means STOP. R2 may prepare a basket and must never settle one.
FORBIDDEN = re.compile(r"pay|purchase|buy now|checkout|submit|confirm|place\s*order|bezahlen|zahlung|kasse", re.I)

captured: list[dict] = []
console: list[str] = []


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_context(user_agent=UA, viewport={"width": 1366, "height": 1200}).new_page()

        def on_request(req):
            if "order-draft" in req.url or "order-valid" in req.url or "/orders" in req.url:
                captured.append({"url": req.url, "method": req.method, "body": req.post_data or ""})

        page.on("request", on_request)
        page.on("console", lambda m: console.append(f"{m.type}: {m.text[:140]}") if m.type == "error" else None)

        page.goto(ORDER_URL, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(6_000)

        # 1. Consent banner blocks everything interactive.
        for label in ("AKZEPTIEREN", "Alle akzeptieren", "Accept"):
            try:
                if page.query_selector(f"text={label}"):
                    page.click(f"text={label}", timeout=4000)
                    print(f"dismissed consent via {label!r}")
                    break
            except Exception:
                pass
        page.wait_for_timeout(4_000)

        # 1b. THE ACTUAL BLOCKER, finally measured by looking at the screen: a
        #     "Standort auswählen" location modal stays OPEN with a grey backdrop that
        #     intercepts EVERY click — so the "+" controls are visible but unreachable,
        #     and every click times out. It is why a keyword sweep reported "no
        #     controls exist": they exist, behind an overlay.
        #     Two ways out, in order of robustness:
        #       (a) dismiss via the modal's own X (no state change needed), else
        #       (b) pick the location by its RADIO CIRCLE — clicking the venue TEXT
        #           does not select it, which is why the earlier attempt failed.
        #     "Menü Anzeigen" is disabled by CSS class, so it is never clicked.
        def modal_open() -> bool:
            m = page.query_selector("text=/Standort auswählen/i")
            return bool(m and m.is_visible())

        if modal_open():
            print("location modal is OPEN and intercepting clicks — dismissing")
            # (a) the X. Try several shapes; a close control is safe (no side effects).
            for sel in (
                "[aria-label*=chließen i]", "[aria-label*=close i]",
                "button:has-text('×')", "button:has-text('✕')",
                "[class*=modal] button[class*=close]", "[class*=dialog] button",
            ):
                try:
                    el = page.query_selector(sel)
                    if el and el.is_visible():
                        el.click(timeout=3000)
                        page.wait_for_timeout(2500)
                        if not modal_open():
                            print(f"  dismissed via {sel}")
                            break
                except Exception:
                    continue
            # (b) if still open, select the venue's radio circle, not its text.
            if modal_open():
                for sel in ("[role=radio]", "input[type=radio]", "[class*=radio]", "[class*=circle]"):
                    try:
                        for el in page.query_selector_all(sel):
                            if el.is_visible():
                                el.click(timeout=3000)
                                page.wait_for_timeout(1800)
                                break
                        if modal_open():
                            continue
                        break
                    except Exception:
                        continue
            print("modal still open:", modal_open())

        # A guard so a blocked page can never again be misread as "no controls exist".
        if modal_open():
            page.screenshot(path="/tmp/r2-BLOCKED.png", full_page=False)
            print("ABORT: location modal could not be dismissed; a click would hit the backdrop.")

        # 2. Let the menu hydrate, then scroll to force lazy sections to render.
        try:
            page.wait_for_load_state("networkidle", timeout=30_000)
        except Exception:
            pass
        for _ in range(8):
            page.mouse.wheel(0, 800)
            page.wait_for_timeout(600)

        # 3. Find a REAL dish by name, then click its own add control.
        #    Names come from /api/companies/550/menus, so we know they exist.
        dish_names = ["Curly Fries", "Chili Cheese Nuggets", "Chicken Wings"]
        clicked = None
        for name in dish_names:
            loc = page.locator(f"text=/{name}/").first
            try:
                if not loc.count():
                    continue
                loc.scroll_into_view_if_needed(timeout=5000)
                page.wait_for_timeout(800)
                box = loc.bounding_box()
                if not box:
                    continue
                # Click the row itself (opening a dish detail panel is a normal,
                # non-spending interaction) — NOT a payment control.
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                clicked = name
                print(f"opened dish: {name}")
                break
            except Exception as e:
                print(f"  {name}: {str(e)[:70]}")
        page.wait_for_timeout(5_000)

        # 4. In the detail panel, click a control whose text is an ADD verb but never
        #    a spend verb. Report what we found either way.
        # MEASURED: the "+" add control is an ICON button — its inner text is empty,
        # which is why a text/keyword sweep finds nothing. It is identifiable by its
        # class: `absolute bottom-2 right-2 rounded-full w-8 h-8`. Target that, and
        # still refuse anything matching a spend verb.
        add_pattern = re.compile(r"rounded-full\s+w-8\s+h-8|absolute bottom-2 right-2", re.I)
        candidates = []
        for el in page.query_selector_all("button"):
            try:
                cls = el.get_attribute("class") or ""
                t = (el.inner_text() or "").strip()[:40]
                if FORBIDDEN.search(t):
                    continue
                if add_pattern.search(cls) or re.match(r"\s*\+\s*$", t):
                    candidates.append((t or "<icon>", el))
            except Exception:
                continue
        print(f"add-control candidates: {len(candidates)} (icon buttons matched by class)")

        for label, el in candidates[:2]:          # bounded: rate-limit sensitive
            try:
                el.click(timeout=4000)
                print(f"clicked {label!r}")
                page.wait_for_timeout(5_000)
            except Exception as e:
                print(f"  click failed: {str(e)[:60]}")

        # 5. Nudge a cart view if one exists — cart, never checkout.
        for sel in ("text=/warenkorb/i", "text=/cart/i"):
            try:
                if page.query_selector(sel):
                    page.click(sel, timeout=3000)
                    page.wait_for_timeout(5_000)
                    break
            except Exception:
                pass

        shot = "/tmp/r2-ordering.png"
        page.screenshot(path=shot, full_page=False)
        browser.close()

    with open(OUT, "w") as fh:
        json.dump({"captured": captured, "console_errors": console[:8], "clicked_dish": clicked}, fh, indent=2)

    print(f"\ncaptured {len(captured)} draft/validation request(s) -> {OUT}")
    for c in captured:
        print(f"  {c['method']} {c['url'][:95]}")
        try:
            body = json.loads(c["body"])
            # The whole point: the FIELD LIST is the answer. Values may include
            # contact details, so print structure + id-shaped fields only.
            print("    top-level fields:", sorted(body.keys()))
            def ids(o, path=""):
                out = []
                if isinstance(o, dict):
                    for k, v in o.items():
                        if isinstance(v, (dict, list)):
                            out += ids(v, f"{path}{k}.")
                        elif re.search(r"(^|_)(id|sku|product|article|method|type|quantity|qty)", k, re.I):
                            out.append(f"{path}{k}={v}")
                elif isinstance(o, list):
                    for i, v in enumerate(o[:4]):
                        out += ids(v, f"{path}[{i}].")
                return out
            print("    id/method-shaped:", ids(body)[:16])
        except Exception as e:
            print("    (body not JSON:", str(e)[:40], ")")
    print(f"screenshot: {shot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
