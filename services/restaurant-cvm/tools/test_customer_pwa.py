#!/usr/bin/env python3
"""Playwright test for the customer PWA — recorded as video.

The assertion that matters: when the rail's outcome is UNKNOWN, the screen must
say "do not pay again". A UI that shows a spinner, or worse "failed — try again",
is how a customer pays twice.

Then the rail settles and the same screen must become "Paid" — without the
customer doing anything.
"""
import json
import os
import shutil
import sys
import urllib.request

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("PWA_BASE", "http://127.0.0.1:8795")
OUT = os.environ.get("VIDEO_OUT", "/tmp/pwa-videos")
CHROME = "/usr/bin/google-chrome-stable"


def set_rail(status: str) -> None:
    req = urllib.request.Request(
        f"{BASE}/__test__/rail",
        data=json.dumps({"status": status}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=10).read()


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    failures = []

    def check(name, cond):
        print(("PASS " if cond else "FAIL ") + name, flush=True)
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME if os.path.exists(CHROME) else None,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            record_video_dir=OUT,
            record_video_size={"width": 390, "height": 844},
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{BASE}/web/customer.html", wait_until="load")
        page.wait_for_selector(".item", timeout=10000)
        check("menu renders", page.locator(".item").count() >= 3)
        page.screenshot(path=f"{OUT}/10-menu.png")

        # 2 x Margherita (890) + 1 x Birra (320) = 2100
        items = page.locator(".item")
        items.nth(0).get_by_role("button", name="add one").click()
        items.nth(0).get_by_role("button", name="add one").click()
        items.nth(2).get_by_role("button", name="add one").click()
        page.wait_for_timeout(300)

        total = page.inner_text("#total")
        check("total is priced by the server", "2,100 sats" in total)
        check("item count shown", "3 items" in page.inner_text("#count"))
        page.screenshot(path=f"{OUT}/11-basket.png")

        # Rail says unknown: this is the dangerous state.
        set_rail("unknown")
        page.click("#pay")
        page.wait_for_selector("#sheet.open", timeout=10000)
        # Order creation is side-effect-free; the treasury spends only on an
        # explicit button press.
        page.wait_for_selector("#treasury:not([hidden])", timeout=10000)
        page.click("#treasury")
        page.wait_for_timeout(2500)
        body = page.inner_text("#sheet")
        check("unknown outcome warns against paying again", "do not pay again" in body.lower())
        check("unknown outcome does NOT claim failure", "did not go through" not in body.lower())
        check("invoice is displayed", len(page.inner_text("#invoice")) > 20)
        page.screenshot(path=f"{OUT}/12-unknown.png")

        # Rail settles; the screen must become paid by itself.
        set_rail("settled")
        # Paid-but-unconfirmed is deliberately not the "ok" style: the venue has not
        # acknowledged, so the screen must not look finished.
        page.wait_for_function(
            "() => /paid/i.test(document.getElementById('stateText').textContent)", timeout=15000
        )
        check("paid state appears without customer action", "paid" in page.inner_text("#stateText").lower())
        check("paid is not shown as done before the venue confirms",
              "confirming" in page.inner_text("#stateText").lower())
        page.screenshot(path=f"{OUT}/13-paid.png")

        check("no uncaught page errors", len(errors) == 0)
        if errors:
            print("page errors:", errors[:3], flush=True)

        video = page.video.path() if page.video else None
        ctx.close()
        browser.close()

    if video and os.path.exists(video):
        dest = os.path.join(OUT, "customer-flow.webm")
        shutil.copy(video, dest)
        print("VIDEO " + dest, flush=True)

    print(("RESULT FAIL " + ", ".join(failures)) if failures else "RESULT PASS", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
