#!/usr/bin/env python3
"""Drive a merchant checkout with Playwright — proves the capture MECHANISM at $0.

ADR-0013 (2026-10-18 amendment) constraints honoured structurally:
  * card values arrive on STDIN as JSON, never argv (argv is visible in `ps`),
  * values are never printed, never written to disk, never in a log line,
  * only STATUS is reported: captured / declined / step_up / error class.

This is the browser half that `card_capture.ts` cannot do: filling a merchant's
hosted card form and submitting it. Against the LOCAL fake merchant it costs
nothing and uses synthetic numbers.

Usage:
  echo '{"cardnumber":"4111111111111111","expiry":"08/27","cvv":"123"}' \
    | python3 tools/merchant_driver.py --url http://127.0.0.1:8123/

Exit codes: 0 captured, 3 declined, 4 step-up-unresolved, 2 setup error.
"""
import argparse
import json
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8123/")
    ap.add_argument("--otp", default="", help="3-D Secure code, when the merchant asks")
    ap.add_argument("--headed", action="store_true")
    a = ap.parse_args()

    # Values on stdin only. If stdin is a tty we refuse rather than prompt, so the
    # caller cannot accidentally land them in shell history.
    if sys.stdin.isatty():
        print("ERROR: card values must arrive on stdin, not interactively", file=sys.stderr)
        return 2
    try:
        vals = json.load(sys.stdin)
    except Exception:
        print("ERROR: stdin was not a JSON object", file=sys.stderr)
        return 2

    pan = str(vals.get("cardnumber", ""))
    expiry = str(vals.get("expiry", ""))
    cvv = str(vals.get("cvv", ""))
    if not (pan and expiry and cvv):
        # Report presence only — never the values.
        print(
            f"ERROR: incomplete values (pan={'y' if pan else 'n'} "
            f"expiry={'y' if expiry else 'n'} cvv={'y' if cvv else 'n'})",
            file=sys.stderr,
        )
        return 2

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not a.headed, args=["--no-sandbox"]
        )
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.goto(a.url, wait_until="domcontentloaded", timeout=30000)

        # Fill the hosted-style fields. `fill()` triggers input events, which is what
        # enables the submit button in a real checkout.
        page.fill("#cn", pan)
        page.fill("#ex", expiry)
        page.fill("#cv", cvv)

        # The button is disabled until the form validates — the same trap that made
        # a previous SPA control unclickable. Wait for it to enable, but treat a
        # timeout as a DECLINE rather than an exception: a merchant that refuses
        # invalid fields is doing its job, and the caller needs a verdict, not a
        # stack trace. (This was a real bug: an invalid PAN crashed the driver.)
        try:
            page.wait_for_function(
                "() => !document.getElementById('pay').disabled", timeout=8000
            )
        except Exception:
            print("STATUS: declined  (merchant never enabled submit — fields rejected)")
            browser.close()
            return 3
        page.click("#pay")
        page.wait_for_timeout(2500)

        msg = (page.text_content("#msg") or "").strip()
        # The page's own words are the result. Contains no card data by construction.
        lower = msg.lower()
        if "captured" in lower:
            print(f"STATUS: captured  ({msg[:80]})")
            browser.close()
            return 0
        if "declined" in lower:
            print(f"STATUS: declined  ({msg[:80]})")
            browser.close()
            return 3

        # Step-up path: the merchant wants a 3-D Secure code.
        if page.query_selector("#otp"):
            if not a.otp:
                print("STATUS: step_up_required (no --otp supplied)")
                browser.close()
                return 4
            page.fill("#otp", a.otp)
            page.click("#v")
            page.wait_for_timeout(2500)
            msg2 = (page.text_content("#msg") or "").strip()
            if "captured" in msg2.lower():
                print(f"STATUS: captured_after_step_up  ({msg2[:80]})")
                browser.close()
                return 0
            print(f"STATUS: step_up_failed  ({msg2[:80]})")
            browser.close()
            return 3

        print(f"STATUS: unknown  ({msg[:100]})")
        browser.close()
        return 3


if __name__ == "__main__":
    sys.exit(main())
