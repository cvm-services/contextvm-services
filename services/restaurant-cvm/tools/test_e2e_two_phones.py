#!/usr/bin/env python3
"""End-to-end: a customer phone and a facilitator phone, together.

The customer orders and pays; the facilitator takes control of the session that
the paid order created; the venue confirms; the customer's screen shows the venue
reference. Two browser contexts, both recorded, then composited side by side.

WHAT THIS PROVES: the two halves of the product are wired to the same order.
WHAT IT DOES NOT PROVE: a real venue, a real captcha solve, or real sats. The
venue confirmation is simulated explicitly via /__test__/venue/confirm, because
automating hCaptcha was measured to be impossible twice and faking it silently
would be worse than labelling it.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("PWA_BASE", "http://127.0.0.1:8795")
OUT = os.environ.get("VIDEO_OUT", "/tmp/pwa-videos/e2e")
CHROME = "/usr/bin/google-chrome-stable"
PHONE = {"width": 390, "height": 844}


def post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


def get_sessions():
    req = urllib.request.Request(f"{BASE}/sessions", headers={"authorization": "Bearer tok-demo"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read()).get("sessions", [])


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

        def phone(role):
            ctx = browser.new_context(
                viewport=PHONE, device_scale_factor=2,
                record_video_dir=OUT, record_video_size=PHONE,
            )
            page = ctx.new_page()
            page.goto(f"{BASE}/web/{'customer' if role == 'customer' else 'facilitator'}.html",
                      wait_until="load")
            return ctx, page

        cust_ctx, cust = phone("customer")
        fac_ctx, fac = phone("facilitator")
        errors = []
        cust.on("pageerror", lambda e: errors.append(f"customer: {e}"))
        fac.on("pageerror", lambda e: errors.append(f"facilitator: {e}"))

        # ---- 1. customer orders and pays -----------------------------------
        post("/__test__/rail", {"status": "settled"})
        cust.wait_for_selector(".item", timeout=10000)
        items = cust.locator(".item")
        items.nth(1).get_by_role("button", name="add one").click()   # Diavola 1090
        items.nth(2).get_by_role("button", name="add one").click()   # Birra 320
        cust.wait_for_timeout(300)
        check("customer total priced by server", "1,410 sats" in cust.inner_text("#total"))

        cust.click("#pay")
        cust.wait_for_selector("#sheet.open", timeout=10000)
        # Paid-but-unconfirmed is deliberately NOT the "ok" style: the venue has
        # not acknowledged yet, so the screen must not look finished.
        cust.wait_for_function(
            "() => /paid/i.test(document.getElementById('stateText').textContent)",
            timeout=15000,
        )
        check("customer reaches paid", "paid" in cust.inner_text("#stateText").lower())
        check("paid is not shown as done before the venue confirms",
              "confirming" in cust.inner_text("#stateText").lower())
        cust.screenshot(path=f"{OUT}/e2e-1-customer-paid.png")

        # ---- 2. the paid order created a facilitator session ---------------
        # Match the CURRENT order, not the first one that looks like an order id:
        # sessions accumulate across runs, and confirming an old one would pass
        # this test while proving nothing about the order under test.
        current_order = cust.evaluate("() => order.order_id")
        sessions = get_sessions()
        paid_order = next((s for s in sessions if s["order_id"] == current_order), None)
        check("the paid order created its own facilitator session", paid_order is not None)

        fac.fill("#token", "tok-demo")
        fac.click("#save")
        fac.wait_for_selector("#list .card", timeout=10000)
        fac.wait_for_timeout(500)
        check("facilitator sees the order's session",
              paid_order is not None and paid_order["session_id"] in fac.inner_text("#list"))
        fac.screenshot(path=f"{OUT}/e2e-2-facilitator-list.png")

        # ---- 3. facilitator takes control ----------------------------------
        fac.get_by_role("button", name="Take control").last.click()
        fac.wait_for_selector("#viewer.open", timeout=10000)
        check("facilitator opens the viewer", "mock-vnc" in (fac.get_attribute("#frame", "src") or ""))
        fac.wait_for_timeout(800)
        fac.screenshot(path=f"{OUT}/e2e-3-facilitator-viewer.png")

        # ---- 4. venue confirms --------------------------------------------
        res = post("/__test__/venue/confirm", {"order_id": paid_order["order_id"], "ref": "TB-E2E-42"})
        check("venue confirmation accepted", res.get("ok") is True)

        # ---- 5. the customer's screen reflects it --------------------------
        cust.wait_for_function(
            "() => document.getElementById('footHint') && "
            "document.getElementById('footHint').textContent.includes('TB-E2E-42')",
            timeout=15000,
        )
        check("customer sees the venue reference", "TB-E2E-42" in cust.inner_text("#footHint"))
        cust.screenshot(path=f"{OUT}/e2e-4-customer-confirmed.png")

        check("no uncaught page errors", len(errors) == 0)
        if errors:
            print("errors:", errors[:3], flush=True)

        cv = cust.video.path() if cust.video else None
        fv = fac.video.path() if fac.video else None
        cust_ctx.close()
        fac_ctx.close()
        browser.close()

    left = right = None
    if cv and os.path.exists(cv):
        left = os.path.join(OUT, "customer.webm")
        shutil.move(cv, left)
    if fv and os.path.exists(fv):
        right = os.path.join(OUT, "facilitator.webm")
        shutil.move(fv, right)

    # Composite side by side so both phones can be watched at once.
    if left and right and shutil.which("ffmpeg"):
        comp = os.path.join(OUT, "two-phones.mp4")
        r = subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", left, "-i", right,
            "-filter_complex",
            "[0:v]scale=390:844,pad=400:844:5:0:color=0x0f1115[l];"
            "[1:v]scale=390:844[rv];[l][rv]hstack=inputs=2[out]",
            "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", comp,
        ], capture_output=True, timeout=180)
        print(("VIDEO " + comp) if os.path.exists(comp) else f"composite failed: {r.stderr[:200]}", flush=True)

    print(("RESULT FAIL " + ", ".join(failures)) if failures else "RESULT PASS", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
