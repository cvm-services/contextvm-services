#!/usr/bin/env python3
"""End-to-end: the money comes back when the venue refuses the order.

The path that has never run: customer pays, the restaurant rejects the order, the
customer is made whole, and the screen says so.

The refund is NOT triggered by the test flipping a status. It goes through
OrderFlow, so the real rule executes: a refund happens only on a KNOWN venue
failure. (An UNKNOWN outcome must never refund — that path is covered by unit
tests and deliberately not exercised here.)
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PWA_BASE", "http://127.0.0.1:8795")
OUT = os.environ.get("VIDEO_OUT", "/tmp/pwa-videos/refund")
CHROME = "/usr/bin/google-chrome-stable"


def _req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"content-type": "application/json"}, method=method,
    )
    return json.loads(urllib.request.urlopen(r, timeout=10).read())


def main() -> int:
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    failures = []

    def check(name, cond):
        print(("PASS " if cond else "FAIL ") + name, flush=True)
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME if os.path.exists(CHROME) else None,
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844}, device_scale_factor=2,
            record_video_dir=OUT, record_video_size={"width": 390, "height": 844},
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        _req("/__test__/rail", "POST", {"status": "settled"})
        page.goto(f"{BASE}/web/customer.html", wait_until="load")
        page.wait_for_selector(".item", timeout=10000)

        page.locator(".item").nth(0).get_by_role("button", name="add one").click()
        page.click("#pay")
        page.wait_for_function(
            "() => /paid/i.test(document.getElementById('stateText').textContent)", timeout=15000
        )
        check("customer pays", "paid" in page.inner_text("#stateText").lower())

        order_id = page.evaluate("() => order.order_id")

        # The venue refuses. This runs OrderFlow, not a status flip.
        res = _req("/__test__/venue/fail", "POST", {"order_id": order_id})
        check("venue failure accepted", res.get("ok") is True)
        check("order reached the refunded state",
              (res.get("result") or {}).get("state") == "refunded")

        recorded = _req("/__test__/refunds").get("refunds", [])
        mine = [r for r in recorded if r["order_id"] == order_id]
        check("a refund was actually recorded", len(mine) == 1)
        check("the refund names a reason", bool(mine and "sold out" in mine[0]["reason"]))

        page.wait_for_function(
            "() => /refunded/i.test(document.getElementById('stateText').textContent)", timeout=15000
        )
        body = page.inner_text("#sheet")
        check("customer is told they were made whole", "made whole" in body.lower())
        check("customer is NOT told the payment failed", "did not go through" not in body.lower())
        page.screenshot(path=f"{OUT}/refund-final.png")

        check("no uncaught page errors", len(errors) == 0)
        if errors:
            print("errors:", errors[:3], flush=True)

        video = page.video.path() if page.video else None
        ctx.close()
        browser.close()

    if video and os.path.exists(video):
        src = os.path.join(OUT, "refund.webm")
        shutil.move(video, src)
        if shutil.which("ffmpeg"):
            mp4 = os.path.join(OUT, "refund.mp4")
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error", "-i", src,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
            ], capture_output=True, timeout=120)
            print("VIDEO " + (mp4 if os.path.exists(mp4) else src), flush=True)

    print(("RESULT FAIL " + ", ".join(failures)) if failures else "RESULT PASS", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
