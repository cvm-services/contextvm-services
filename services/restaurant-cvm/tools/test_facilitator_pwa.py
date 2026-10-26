#!/usr/bin/env python3
"""Playwright test for the facilitator PWA — recorded as video.

Phone-sized viewport on purpose: this UI is meant to be used on a phone while the
operator is also holding a second phone as the customer.

What it proves:
  1. a facilitator token is required (no token -> the list never renders);
  2. sessions appear with their honest state;
  3. "Take control" issues a grant, sets the cookie, and opens the viewer;
  4. "Release" clears the grant and closes the viewer;
  5. an `outcome_unknown` session shows the do-not-refund warning.

Exits non-zero if any assertion fails.
"""
import os
import shutil
import sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("PWA_BASE", "http://127.0.0.1:8795")
OUT = os.environ.get("VIDEO_OUT", "/tmp/pwa-videos")
CHROME = "/usr/bin/google-chrome-stable"


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

        page.goto(f"{BASE}/web/facilitator.html", wait_until="load")

        # 1. token gate
        expect(page.locator("#auth")).to_be_visible()
        check("token gate is shown before authentication", page.locator("#auth").is_visible())
        page.screenshot(path=f"{OUT}/01-token-gate.png")

        # 2. authenticate
        page.fill("#token", "tok-demo")
        page.click("#save")
        page.wait_for_selector("#list .card", timeout=10000)
        check("session list renders after connecting", page.locator("#list .card").count() >= 2)
        page.wait_for_timeout(600)
        page.screenshot(path=f"{OUT}/02-session-list.png")

        # 3. states are honest
        body = page.inner_text("body")
        check("awaiting human state is shown", "awaiting human" in body.lower())
        check("unconfirmed state is shown", "outcome unknown" in body.lower())
        check(
            "unconfirmed session carries a do-not-refund warning",
            "do not refund" in body.lower(),
        )

        # 4. take control
        page.get_by_role("button", name="Take control").first.click()
        page.wait_for_selector("#viewer.open", timeout=10000)
        src = page.get_attribute("#frame", "src") or ""
        check("viewer opens with the session url", "mock-vnc" in src)
        cookies = ctx.cookies()
        check("grant cookie is set", any(c["name"] == "cvm_grant" for c in cookies))
        page.wait_for_timeout(1200)
        page.screenshot(path=f"{OUT}/03-viewer.png")

        # 5. release
        page.click("#release")
        page.wait_for_selector("#viewer.open", state="detached", timeout=10000)
        page.wait_for_timeout(800)
        after = ctx.cookies()
        check(
            "release clears the grant cookie",
            not any(c["name"] == "cvm_grant" and c["value"] for c in after),
        )
        page.screenshot(path=f"{OUT}/04-released.png")

        check("no uncaught page errors", len(errors) == 0)
        if errors:
            print("page errors:", errors[:3], flush=True)

        video = page.video.path() if page.video else None
        ctx.close()
        browser.close()

    if video and os.path.exists(video):
        dest = os.path.join(OUT, "facilitator-flow.webm")
        shutil.copy(video, dest)
        print("VIDEO " + dest, flush=True)

    print(("RESULT FAIL " + ", ".join(failures)) if failures else "RESULT PASS", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
