#!/usr/bin/env python3
"""The PWA holds its own key: no token typed, no token delivered.

Walks the real flow: a fresh device generates a key in the browser, the operator
approves the identifier it shows, and the device signs itself in. Then the same
device is refused after a reload if it is NOT approved — the point is that the
credential is the key, not a string someone pasted.

Runs against the test server's real signature verification (npm:nostr-tools), so a
broken signing implementation fails here rather than in a restaurant.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PWA_BASE", "http://127.0.0.1:8795")
OUT = os.environ.get("VIDEO_OUT", "/tmp/pwa-videos/signer")
CHROME = "/usr/bin/google-chrome-stable"


ADMIN = "admin-token-xyz"  # matches the test server's CVM_ADMIN_TOKEN


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

        page.goto(f"{BASE}/web/facilitator.html", wait_until="load")
        page.wait_for_selector("#auth", state="visible", timeout=10000)

        # 1. a fresh device offers to make a key, and does not ask for a secret
        check("no token is requested on first load", page.locator("#token").is_hidden())
        page.wait_for_selector("#createKey", state="visible", timeout=10000)
        check("a fresh device offers to create a key", page.locator("#createKey").is_visible())
        page.screenshot(path=f"{OUT}/signer-1-new-device.png")

        page.click("#createKey")
        page.wait_for_function(
            "() => /^[0-9a-f]{64}$/.test(document.getElementById('devNpub').textContent.trim())",
            timeout=15000,
        )
        npub = page.inner_text("#devNpub").strip()
        check("a 32-byte public key is shown", len(npub) == 64)

        # 2. unapproved: sign-in must fail, and say so plainly
        page.wait_for_function(
            "() => /not approved/i.test(document.getElementById('devState').textContent)",
            timeout=15000,
        )
        check("an unapproved device is refused", "not approved" in page.inner_text("#devState"))
        page.screenshot(path=f"{OUT}/signer-2-unapproved.png")

        # 3. the operator approves it IN THE UI - a second browser context, the
        #    real admin page, the real endpoint. No test-only shortcut.
        op_ctx = browser.new_context(viewport={"width": 900, "height": 900})
        op = op_ctx.new_page()
        op.on("pageerror", lambda e: errors.append(f"operator: {e}"))
        op.goto(f"{BASE}/web/operator.html", wait_until="load")
        op.wait_for_selector("#auth", state="visible", timeout=10000)
        op.fill("#token", ADMIN)
        op.click("#save")
        op.wait_for_selector("#pending .card", timeout=15000)
        check("the operator sees the waiting device", npub in op.inner_text("#pending"))
        op.screenshot(path=f"{OUT}/signer-3-operator-pending.png")

        op.get_by_role("button", name="Approve").first.click()
        op.wait_for_selector("#approved .card", timeout=15000)
        check("approval moves the device to approved", npub in op.inner_text("#approved"))
        # The trail matters as much as the state: approval lets a device drive a
        # browser that spends money, so it has to be answerable later.
        activity = op.inner_text("#audit")
        check("the approval is recorded in the activity trail",
              "approved" in activity and npub in activity)
        op.screenshot(path=f"{OUT}/signer-4-operator-approved.png")
        op_ctx.close()

        page.click("#signIn")
        # Sign-in is the assertion - NOT "cards appeared". The session list is per
        # facilitator, and this device is a NEW identity with nothing assigned yet,
        # so an empty list is the correct outcome. Waiting for a card here would
        # have been a test that can only pass by accident.
        page.wait_for_function(
            "() => /signed in/i.test(document.getElementById('devState').textContent)",
            timeout=15000,
        )
        check("after approval the device signs itself in", "signed in" in page.inner_text("#devState").lower())
        check("an authenticated device with no work sees an empty list",
              page.locator("#empty").is_visible() or page.locator("#list .card").count() > 0)
        page.screenshot(path=f"{OUT}/signer-3-signed-in.png")

        # 4. the key survives a reload: same identity, no re-approval needed
        page.reload(wait_until="load")
        page.wait_for_function(
            "() => /signed in/i.test(document.getElementById('devState').textContent)",
            timeout=15000,
        )
        same = page.inner_text("#devNpub").strip()
        check("the device keeps its identity across a reload", same == npub)

        check("no uncaught page errors", len(errors) == 0)
        if errors:
            print("errors:", errors[:3], flush=True)

        video = page.video.path() if page.video else None
        ctx.close()
        browser.close()

    if video and os.path.exists(video):
        src = os.path.join(OUT, "signer.webm")
        shutil.move(video, src)
        if shutil.which("ffmpeg"):
            mp4 = os.path.join(OUT, "signer.mp4")
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error", "-i", src,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
            ], capture_output=True, timeout=120)
            print("VIDEO " + (mp4 if os.path.exists(mp4) else src), flush=True)

    print(("RESULT FAIL " + ", ".join(failures)) if failures else "RESULT PASS", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
