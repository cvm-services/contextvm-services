#!/usr/bin/env python3
"""R2 unblock: capture the storefront's OWN POST /order-drafts body.

The measured contract (docs/r2-order-drafts-contract.md) knows every field except
the VALUE of `line_items[].product_id` — the API rejects our menu `sku` and we have
no catalog endpoint to map it. The storefront builds the draft client-side, so its
own request contains real ids. The UI calls ARE the contract.

OBSERVATION ONLY. This script:
  * never enters payment,
  * never types card data (card fields are Stripe cross-origin iframes),
  * clicks only "add to cart" style controls, and refuses anything matching
    /pay|purchase|buy now|checkout|submit|confirm|place order/i,
  * makes ONE page load and a bounded number of interactions — the host is
    rate-limit sensitive.

It writes the captured bodies to /tmp and prints the ID-SHAPED fields only.
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

STORE = os.environ.get("TB_STORE", "https://threebuddies.foodamigos-storefront.com")
OUT = "/tmp/threebuddies-drafts.json"

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

FORBIDDEN = re.compile(r"pay|purchase|buy now|checkout|submit|confirm|place\s*order|bezahlen", re.I)
ADD_WORDS = re.compile(r"hinzuf|add|\+|warenkorb|cart|bestell", re.I)

captured: list[dict] = []


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_context(user_agent=UA, viewport={"width": 1366, "height": 900}).new_page()

        def on_request(req):
            if "order-drafts" in req.url or "order-validations" in req.url:
                captured.append({"url": req.url, "method": req.method,
                                 "body": req.post_data or ""})

        page.on("request", on_request)
        page.goto(STORE, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(6_000)

        # Find add-to-cart style controls. Refuse anything that looks like payment.
        targets = []
        for el in page.query_selector_all("button, a[role=button], [class*=add], [class*=Add]"):
            try:
                label = (el.inner_text() or "").strip()[:40]
                if label and ADD_WORDS.search(label) and not FORBIDDEN.search(label):
                    targets.append((label, el))
            except Exception:
                continue

        print("add-to-cart candidates:", [t[0] for t in targets[:8]])
        for label, el in targets[:2]:            # at most 2 clicks: rate-limit sensitive
            try:
                print(f"clicking {label!r}")
                el.click(timeout=4000)
                page.wait_for_timeout(4000)
            except Exception as e:
                print("  click failed:", str(e)[:60])

        # Nudge the storefront into building a draft if a cart view exists.
        for sel in ("text=/warenkorb|cart|bestellung/i",):
            try:
                if page.query_selector(sel):
                    page.click(sel, timeout=3000)
                    page.wait_for_timeout(4000)
            except Exception:
                pass

        browser.close()

    with open(OUT, "w") as fh:
        json.dump(captured, fh, indent=2)

    print(f"\ncaptured {len(captured)} order-draft/validation request(s) -> {OUT}")
    for c in captured:
        print(f"  {c['method']} {c['url'][:90]}")
        try:
            body = json.loads(c["body"])
            # ID-SHAPED FIELDS ONLY — never dump the whole body (it carries contact
            # details), and never card data.
            def ids(o, path=""):
                out = []
                if isinstance(o, dict):
                    for k, v in o.items():
                        if isinstance(v, (dict, list)):
                            out += ids(v, f"{path}{k}.")
                        elif re.search(r"(^|_)(id|sku|product|article)", k, re.I):
                            out.append(f"{path}{k}={v}")
                elif isinstance(o, list):
                    for i, v in enumerate(o[:5]):
                        out += ids(v, f"{path}[{i}].")
                return out
            print("    ID FIELDS:", ids(body)[:12])
        except Exception as e:
            print("    (body not JSON:", str(e)[:50], ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
