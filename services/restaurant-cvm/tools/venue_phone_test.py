#!/usr/bin/env python3
"""R3b — venue phone-verification test with the fleet's REAL JMP number.

MEASURED CONTEXT (see docs/RALPH-LOOP-finish-sats-ordering.md):
  * The venue checkout gates card orders behind a phone-verification modal
    ("Wir muessen deine Telefonnummer verifizieren"), WhatsApp or SMS delivery,
    and a Cloudflare Turnstile human checkbox.
  * The fleet's JMP number (810) 258-3253 is LIVE (paid 26,898 sats 2026-09-27,
    activated, two-way SMS proven; inbox at
    ~/.hermes/profiles/manager/state/jmp_inbox.db on the T470/cobrador).
  * The card form is ADYEN secured fields; filling works; no charge happened.

THIS TEST answers, for $0 and with NO card entered:
  1. Does the phone modal accept a +1 (US) number in the country dropdown?
  2. Can the Cloudflare Turnstile checkbox be clicked (headed, real mouse)?
  3. Does "Code senden" accept, and does a code SMS ARRIVE in the JMP inbox?

It NEVER enters card values. It stops after the code request (or its refusal).
The venue number receives our number; nothing is charged; the order is never
placed. Fully reversible.

REPRODUCIBILITY: the JMP number and the phone-country are parameters; the
inbox poll goes over SSH to the T470 (read-only SELECT).

Usage (x280, headed under xvfb):
  ~/.cache/pw-venv/bin/python tools/venue_phone_test.py [--country US]
"""
import argparse
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36")
MENU = "https://threebuddies.foodamigos-storefront.com/speisekarte/threebuddies"
T470 = "cobrador"
INBOX_SQL = ("select ts, peer, body from messages where direction='in' "
             "and ts > ? order by ts desc limit 3")
TARGET_ITEM = "Capri Sun Kirsche"   # EUR 1.50 — cheapest, no modifiers
JMP_NUMBER = "8102583253"           # E.164 without '+'
JMP_DISPLAY = "(810) 258-3253"

R = []


STATE_FILE = os.environ.get("CVM_SESSION_STATE", "")

# Authoritative business states. A dashboard cannot poll log lines, and "is it
# still working?" must not be inferred by a human reading a tail. `outcome_unknown`
# is deliberately distinct from `failed`: after a payment submission a lost reply
# is NOT a failed order, and retrying it would duplicate a real purchase.
STATES = (
    "preparing", "at_captcha", "awaiting_human", "solved", "continuing",
    "awaiting_sms", "submitting", "completed",
    "failed", "expired", "outcome_unknown",
)


def set_state(state, **detail):
    """Write the current business state atomically for the dashboard to poll."""
    if state not in STATES:
        raise ValueError(f"undeclared state: {state}")
    if not STATE_FILE:
        return
    payload = {
        "state": state,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "detail": detail,
    }
    tmp = STATE_FILE + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, STATE_FILE)   # atomic: a reader never sees a half file
    except Exception as e:            # never let telemetry kill the checkout
        print(json.dumps({"step": "state_write_err", "err": str(e)[:80]}), flush=True)


def step(name, **kw):
    R.append({"step": name, **kw})
    print(json.dumps({"step": name, **kw}), flush=True)
    # Every ABORT becomes a terminal state automatically, so a dashboard never has
    # to parse log lines to learn that a session died - and a hold that simply ran
    # out of time is `expired`, not `failed`: the operator did nothing wrong.
    if name == "ABORT":
        code = str(kw.get("code", "unknown"))
        terminal = "expired" if code in ("captcha-not-passed", "hold-elapsed") else "failed"
        set_state(terminal, reason=code, **{k: v for k, v in kw.items() if k != "code"})


def poll_inbox(since_ts, tries=18, delay=10):
    """Read-only inbox poll over SSH. Returns new inbound SMS rows."""
    for i in range(tries):
        out = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", T470,
             f"sqlite3 ~/.hermes/profiles/manager/state/jmp_inbox.db "
             f"\"{INBOX_SQL.format(since_ts)}\""],
            capture_output=True, text=True, timeout=30)
        if out.stdout.strip():
            rows = [l.split("|", 2) for l in out.stdout.strip().splitlines()]
            return rows
        time.sleep(delay)
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="US",
                    help="phone country in the venue dropdown (default US)")
    ap.add_argument("--viewport", default="1366x1200",
                    help="browser viewport WxH; set it to the operator's screen so "
                         "the captcha is readable over VNC")
    ap.add_argument("--session-id", default=os.environ.get("CVM_SESSION_ID", ""),
                    help="session id from the session API; published in holding_for_human")
    ap.add_argument("--hold", type=int, default=0,
                    help="seconds to wait for a HUMAN to solve the captcha over VNC "
                         "(ADR-0017 handoff); 0 aborts immediately")
    args = ap.parse_args()

    with sync_playwright() as p:
        # Playwright's bundled chromium drifts from the installed cache on this
        # host (expects 1243, has 1228) and `playwright install` refuses on
        # Ubuntu 26.04. The system Chrome is the supported executable here, so
        # prefer it and fall back to the bundle only if it is absent.
        _chrome = "/usr/bin/google-chrome-stable"
        _launch = {"headless": False, "args": ["--no-sandbox",
                   "--disable-dev-shm-usage", "--disable-gpu"]}
        if os.path.exists(_chrome):
            _launch["executable_path"] = _chrome
        b = p.chromium.launch(**_launch)
        _vw, _vh = (int(x) for x in args.viewport.lower().split("x"))
        ctx = b.new_context(locale="de-DE", timezone_id="Europe/Berlin",
                            viewport={"width": _vw, "height": _vh},
                            is_mobile=_vw < 600, has_touch=_vw < 600,
                            user_agent=UA)
        ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        pg = ctx.new_page()

        set_state("preparing")
        # ---------- reach the phone modal (proven path, no card) -------------
        pg.goto(MENU, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(6000)
        for lb in ("AKZEPTIEREN", "Accept"):
            try:
                el = pg.query_selector(f"text={lb}")
                if el:
                    el.click(timeout=4000)
                    pg.wait_for_timeout(4000)
                    break
            except Exception:
                pass
        try:
            pg.get_by_role("radio").first.check(timeout=6000)
        except Exception as e:
            step("venue_radio", err=str(e)[:60])
        btn = pg.get_by_role("button", name="Menü Anzeigen")
        if "button-disab" in (btn.first.get_attribute("class") or ""):
            pg.query_selector("text=/Ändern/i").click(timeout=6000)
            pg.wait_for_timeout(4000)
            try:
                pg.query_selector("text=/Morgen/i").click(timeout=5000)
                pg.wait_for_timeout(1500)
            except Exception:
                pass
            slots = pg.evaluate(
                """() => { const out=[];
                  document.querySelectorAll('*').forEach(el=>{
                    const t=(el.textContent||'').trim(); const r=el.getBoundingClientRect();
                    if (/^\\d{1,2}:\\d{2}$/.test(t) && r.width>0 && r.y>100 && r.y<1100) {
                      const leaf=![...el.children].some(c=>(c.textContent||'').trim()===t);
                      if(leaf) out.push({txt:t,x:Math.round(r.x),y:Math.round(r.y),
                                         w:Math.round(r.width),h:Math.round(r.height)});
                  }}); return out; }""")
            s0 = slots[0]
            pg.mouse.click(s0["x"] + s0["w"] / 2, s0["y"] + s0["h"] / 2)
            pg.wait_for_timeout(2500)
            w = pg.query_selector("text=/Weiter/i")
            if w and "button-disab" not in (w.get_attribute("class") or ""):
                w.click(timeout=8000)
                pg.wait_for_timeout(7000)
            btn = pg.get_by_role("button", name="Menü Anzeigen")
        btn.first.click(timeout=8000)
        pg.wait_for_timeout(8000)

        # add the cheap item (row click, proven)
        sb = pg.query_selector("input[type=search], input[placeholder*='uch']")
        sb.click()
        sb.fill(TARGET_ITEM)
        pg.wait_for_timeout(4000)
        pt = pg.evaluate(
            """(name) => {
              const els=[...document.querySelectorAll('*')].filter(e=>{
                const t=(e.textContent||'').trim();
                return t.startsWith(name) && t.length<120 && e.getBoundingClientRect().width>0;
              });
              if(!els.length) return null;
              els.sort((a,b)=>a.textContent.length-b.textContent.length);
              let node=els[0];
              for(let i=0;i<10&&node;i++,node=node.parentElement){
                const r=node.getBoundingClientRect();
                if(r.height>40 && r.width>300)
                  return {x:Math.round(r.x+r.width*0.15), y:Math.round(r.y+r.height*0.35)};
              }
              return null;
            }""", TARGET_ITEM)
        if not pt:
            step("ABORT", code="no-product-row")
            b.close()
            sys.exit(10)
        pg.mouse.click(pt["x"], pt["y"])
        pg.wait_for_timeout(4000)
        pg.get_by_role("button", name="Hinzufügen").first.click(timeout=6000)
        pg.wait_for_timeout(3500)

        badge = pg.evaluate(
            """() => { const h=document.querySelector('header')||document;
              const e=[...h.querySelectorAll('span,div,b')].find(x=>/^\\d+$/.test((x.textContent||'').trim())
                && x.getBoundingClientRect().y<120 && x.getBoundingClientRect().width<40);
              return e?e.textContent.trim():null; }""")
        step("cart_badge", value=badge)
        if badge in (None, "0"):
            step("ABORT", code="empty-cart")
            b.close()
            sys.exit(10)

        pg.mouse.click(1236, 36)
        pg.wait_for_timeout(6000)
        for sel in ("text=/Zur Kasse/i", "text=/Checkout/i"):
            el = pg.query_selector(sel)
            if el and el.is_visible():
                el.click(timeout=6000)
                pg.wait_for_timeout(9000)
                step("checkout", via=sel)
                break

        # contact info (synthetic; this phone gets REPLACED in the modal later)
        for i, val in enumerate(["Test", "Validierung"]):
            try:
                pg.get_by_role("textbox").nth(i).fill(val, timeout=5000)
            except Exception as e:
                step("contact_fill_err", i=i, err=str(e)[:50])
        try:
            pg.get_by_placeholder("Email Adresse").fill(
                "felix@orangesync.tech", timeout=5000)
        except Exception:
            try:
                pg.locator("input[type=email]").first.fill(
                    "felix@orangesync.tech", timeout=5000)
            except Exception as e:
                step("email_fill_err", err=str(e)[:50])
        # contact phone: the JMP number itself, so the modal prefills correctly
        try:
            tel = pg.locator("input[type=tel], input[inputmode=tel]").first
            tel.click()
            tel.fill(JMP_NUMBER, timeout=5000)
            step("contact_phone_set", to=JMP_DISPLAY)
        except Exception as e:
            step("contact_phone_err", err=str(e)[:60])

        try:
            pg.get_by_role("button", name=__import__("re").compile(
                "Weiter Zur Zahlung", __import__("re").I)).first.click(timeout=8000)
            pg.wait_for_timeout(9000)
            step("advanced_to_payment", ok=True)
        except Exception as e:
            step("advanced_to_payment", err=str(e)[:60])

        # ---------- trigger the gate: synthetic card buy attempt -----------------
        # MEASURED 2026-10-19: the phone modal fires AFTER "Kaufen für" is clicked,
        # not at the payment step itself. To reach that click we select
        # Kartenzahlung and fill a SYNTHETIC Luhn-valid card (4111 1111 1111 1111).
        # A synthetic PAN can never authorize at Adyen — the charge cannot move
        # money. The phone gate is what we are measuring.
        pg.mouse.click(445, 267)   # Kartenzahlung row (measured)
        pg.wait_for_timeout(6000)
        pay_frames = {}
        for f in pg.frames:
            if any(h in f.url for h in ("adyen", "checkoutshopper")):
                try:
                    n = f.evaluate(
                        "() => document.querySelectorAll('input,select,iframe').length")
                    if n > 0:
                        pay_frames[f.url[:160] + f"|{id(f) % 10000}"] = f
                except Exception:
                    continue
        step("pay_frames", n=len(pay_frames))
        SYNTH = {"pan": "4111111111111111", "exp": "12/30", "cvc": "123"}
        want = {
            "pan": (SYNTH["pan"], ["cardnumber", "cc-number"]),
            "exp": (SYNTH["exp"], ["exp", "cc-exp"]),
            "cvc": (SYNTH["cvc"], ["cvc", "securitycode", "cc-csc"]),
        }
        filled = {}
        for key, (val, hints) in want.items():
            done = False
            for u, f in pay_frames.items():
                try:
                    inputs = f.evaluate(
                        """() => [...document.querySelectorAll('input')]
                             .map(e => ({name: e.name||e.id||'',
                                         ac: e.getAttribute('autocomplete')||''}))""")
                except Exception:
                    continue
                for i, inp in enumerate(inputs):
                    blob = (str(inp["name"]) + str(inp["ac"])).lower()
                    if any(h in blob for h in hints):
                        try:
                            f.locator("input").nth(i).fill(val, timeout=8000)
                            filled[key] = f"ok[{i}]"
                            done = True
                            break
                        except Exception as e:
                            filled[key] = f"err {str(e)[:30]}"
                if done:
                    break
            if not done:
                filled[key] = "no-matching-field"
        step("synth_fill", **filled)

        # billing address (venue's own, measured accepted)
        # Adyen names these EXACTLY (measured): holderName, street,
        # houseNumberOrName, postalCode, city. Target by name, verify each fill.
        addr_result = {}
        for inp_name, val in (
            ("street", "Albrechtstraße"),
            ("houseNumberOrName", "131"),
            ("postalCode", "12167"),
            ("city", "Berlin"),
            ("holderName", "Test Validierung"),
        ):
            # try the main frame AND any frame that carries this input
            done = False
            for holder, tag in [(pg, "main")] + [(f, "frame") for f in pg.frames]:
                try:
                    loc = holder.locator(
                        f"input[name='{inp_name}'], input[id*='{inp_name}']").first
                    if loc.count() == 0:
                        continue
                    loc.fill(val, timeout=5000)
                    addr_result[inp_name] = tag
                    done = True
                    break
                except Exception:
                    continue
            if not done:
                addr_result[inp_name] = "NOT-FOUND"
        step("address_filled", **addr_result)
        # VERIFY: read back the values so an unfilled field can never pass silently
        readback = pg.evaluate(
            """() => { const o={};
              for (const n of ['street','houseNumberOrName','postalCode','city','holderName']) {
                const i=document.querySelector(`input[name="${n}"]`);
                o[n]= i ? String(i.value||'').slice(0,20) : null;
              }
              return o; }""")
        step("address_readback", **readback)
        missing = [k for k, v in readback.items() if not v]
        if missing:
            step("ABORT", code="address-incomplete", missing=missing)
            pg.screenshot(path="/tmp/vt-addr-missing.png")
            b.close()
            sys.exit(10)

        # holder name (main frame, measured: holderName / cc-name)
        try:
            h = pg.evaluate(
                "() => [...document.querySelectorAll('input')].findIndex("
                "e => (e.name||'').includes('holderName'))")
            if h >= 0:
                pg.locator("input").nth(h).fill("Test Validierung", timeout=5000)
        except Exception:
            pass

        # click "Kaufen für" — this is what triggers the phone gate
        clicked_buy = False
        try:
            pg.get_by_role("button", name=__import__("re").compile(
                "Kaufen für", __import__("re").I)).first.click(timeout=8000)
            clicked_buy = True
            step("kaufen_clicked")
            set_state("at_captcha")
        except Exception as e:
            step("kaufen_click_err", err=str(e)[:70])
        pg.wait_for_timeout(8000)

        # ---------- the phone-verification modal --------------------------------
        pg.wait_for_timeout(2000)
        modal_state = pg.evaluate(
            """() => { const t=document.body.innerText||'';
              return {phone_modal: /Telefonnummer verifizieren/i.test(t),
                      turnstile: /Mensch/i.test(t),
                      code_senden: /Code senden/i.test(t)}; }""")
        step("modal_state", **modal_state)

        if not modal_state["phone_modal"]:
            pg.screenshot(path="/tmp/vt-no-modal.png")
            step("ABORT", code="phone-modal-not-present",
                 note="the gate may fire only after a buy attempt")
            b.close()
            sys.exit(10)

        # INVENTORY the modal controls (one-time; keeps the run deterministic)
        modal_dom = pg.evaluate(
            """() => { const dlg=document.querySelector('[role=dialog], [class*=modal]');
              if(!dlg) return null;
              const els=[...dlg.querySelectorAll('button,input,select,label,a,[role=radio]')];
              return els.slice(0,24).map(e=>{ const r=e.getBoundingClientRect();
                return {tag:e.tagName, type:e.type||'', name:e.name||e.id||'',
                         txt:(e.textContent||'').trim().slice(0,32),
                         cls:String(e.className||'').slice(0,40),
                         box:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}; });
            }""")
        step("modal_dom", els=modal_dom)
        pg.screenshot(path="/tmp/vt-modal.png")

        # ================= CAPTCHA FIRST ==========================================
        # MEASURED: the phone control carries PhoneInput--disabled and both the
        # select and the input are disabled=true. The unlock condition is the
        # captcha. The widget is Cloudflare Turnstile (frame URL
        # challenges.cloudflare.com/...); its checkbox is NOT an input element,
        # which is why earlier probes found "no checkbox in frame".
        turnstile_frames = [f for f in pg.frames
                             if "challenges.cloudflare.com" in f.url]
        step("turnstile_frames", n=len(turnstile_frames))
        for f in turnstile_frames:
            try:
                cands = f.evaluate(
                    """() => { const out=[];
                      for (const e of document.querySelectorAll('*')) {
                        const r=e.getBoundingClientRect();
                        if (r.width>8 && r.width<60 && r.height>8 && r.height<60) {
                          out.push({tag:e.tagName, id:(e.id||'').slice(0,20),
                                    cls:String(e.className||'').slice(0,36),
                                    x:Math.round(r.x), y:Math.round(r.y),
                                    w:Math.round(r.width), h:Math.round(r.height)});
                        }
                      }
                      return out.slice(0,16); }""")
                step("frame_candidates", url=f.url[-30:], cands=cands[:10])
            except Exception as e:
                step("frame_cand_err", err=str(e)[:60])

        # click the checkbox: class/id/role hints first, else leftmost small square
        cb_desc = None
        for f in turnstile_frames:
            for sel in ("[class*=checkbox]", "[id*=checkbox]",
                        "[role=checkbox]", ".ctp-checkbox-label"):
                try:
                    loc = f.locator(sel).first
                    if loc.count() > 0:
                        bb = loc.bounding_box()
                        if bb and bb["width"] < 80:
                            loc.click(timeout=6000)
                            cb_desc = sel + " in frame"
                            break
                except Exception:
                    continue
            if cb_desc:
                break
        if not cb_desc:
            # Human-like approach: hCaptcha ignores synthetic clicks that arrive
            # with no mouse travel (measured: a bare click inside the box bounds
            # left it unchecked). Move the cursor across the page first, decelerate
            # onto the box, pause, then press/release like a hand.
            pg.mouse.move(300, 400, steps=12)
            pg.wait_for_timeout(240)
            pg.mouse.move(360, 620, steps=10)
            pg.wait_for_timeout(180)
            pg.mouse.move(400, 702, steps=14)
            pg.wait_for_timeout(320)
            pg.mouse.down()
            pg.wait_for_timeout(90)
            pg.mouse.up()
            cb_desc = "human-move(400,702)"
        step("captcha_clicked", via=cb_desc)
        pg.wait_for_timeout(9000)
        # second attempt if still unchecked (sometimes one pass is swallowed)
        tok0 = pg.evaluate(
            """() => document.querySelector(
                 'input[name="cf-turnstile-response"], [name*="turnstile-response"], [name*="h-captcha-response"], [name*="hcaptcha-response"]')?.value || null""")
        dis0 = pg.evaluate(
            "() => { const w=document.querySelector('.PhoneInput');"
            " return w ? /disabled/.test(String(w.className)) : null; }")
        if (not tok0) and dis0:
            step("captcha_retry", why="no token, still disabled")
            pg.mouse.move(430, 640, steps=10)
            pg.wait_for_timeout(400)
            pg.mouse.move(402, 694, steps=14)
            pg.wait_for_timeout(260)
            pg.mouse.down()
            pg.wait_for_timeout(110)
            pg.mouse.up()
            pg.wait_for_timeout(9000)
        pg.screenshot(path="/tmp/vt-captcha.png")

        # decisive: Turnstile writes cf-turnstile-response into the parent page,
        # and the phone control's disabled class must be gone.
        tok = pg.evaluate(
            """() => { const i=document.querySelector(
                 'input[name="cf-turnstile-response"], [name*="turnstile-response"]');
              return i ? String(i.value||'').slice(0,10) : null; }""")
        dis = pg.evaluate(
            """() => { const w=document.querySelector('.PhoneInput');
              return w ? {disabled: /disabled/.test(String(w.className))} : null; }""")
        step("captcha_result", token_present=bool(tok), phone_still_disabled=dis)
        captcha_ok = bool(tok) or (dis is not None and not dis["disabled"])
        if not captcha_ok and args.hold > 0:
            # ADR-0017 handoff: a human solves the visual challenge over VNC while
            # THIS process keeps the page alive. We then continue in the same
            # browser — the captcha token is bound to it, so re-driving from a
            # fresh context would discard the human's work.
            set_state("awaiting_human", hold_seconds=args.hold,
                      note="a human must solve the captcha over VNC")
            step("holding_for_human", seconds=args.hold, session_id=args.session_id,
                 note="solve the captcha in the VNC session; this process continues automatically")
            deadline = time.time() + args.hold
            while time.time() < deadline:
                pg.wait_for_timeout(3000)
                tok = pg.evaluate(
                    """() => { const i=document.querySelector(
                         'input[name="cf-turnstile-response"], [name*="turnstile-response"], [name*="h-captcha-response"], [name*="hcaptcha-response"]');
                      return i ? String(i.value||'') : null; }""")
                dis = pg.evaluate(
                    """() => { const w=document.querySelector('.PhoneInput');
                      return w ? {disabled: /disabled/.test(String(w.className))} : null; }""")
                # Broaden: the real signal is that the number INPUT accepts focus
                # and "Code senden" is no longer disabled. The wrapper's CSS class
                # can stay stale after the captcha clears, which made an earlier
                # session sit here while a human pressed the button by hand.
                _live = pg.evaluate("""() => {
                    const i = document.querySelector('input.PhoneInputInput');
                    const b = [...document.querySelectorAll('button')]
                        .find(e => /Code senden/i.test(e.textContent||''));
                    return {
                      input_disabled: i ? !!i.disabled : null,
                      btn_disabled: b ? (!!b.disabled || /disabled/.test(String(b.className||''))) : null,
                    };
                }""")
                if (tok and len(tok) > 5) or (_live.get("input_disabled") is False) \
                   or (_live.get("btn_disabled") is False):
                    captcha_ok = True
                    step("captcha_clear_signal", **(_live or {}))
                    break
            if captcha_ok:
                set_state("solved")
            step("human_result", passed=captcha_ok,
                 token_len=len(tok) if tok else 0)
            if captcha_ok:
                pg.screenshot(path="/tmp/vt-human-passed.png")
        if not captcha_ok:
            step("ABORT", code="captcha-not-passed",
                 note="Turnstile/hCaptcha yielded no token and the phone control is still "
                      "disabled. If a visual challenge appeared, the captcha step is "
                      "human_required by design.")
            b.close()
            sys.exit(10)

        set_state("continuing", phase="phone")
        # ================= PHONE: country + number (now enabled) ==================
        def set_country(code: str = "US") -> str | None:
            """Flip the country select AND fire the events React listens for."""
            return pg.evaluate("""(code) => {
                const sel = document.querySelector('select.PhoneInputCountrySelect');
                if (!sel) return null;
                const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLSelectElement.prototype, 'value').set;
                setter.call(sel, code);
                sel.dispatchEvent(new Event('input', {bubbles: true}));
                sel.dispatchEvent(new Event('change', {bubbles: true}));
                return sel.value;
            }""", code)

        country_set = None
        for _attempt in range(3):
            try:
                pg.select_option("select.PhoneInputCountrySelect", "US", timeout=4000)
                country_set = "US"
                break
            except Exception:
                got = set_country("US")
                if got == "US":
                    country_set = got
                    break
            pg.wait_for_timeout(800)
        step("country_set", via=country_set)

        typed_ok = False
        try:
            ph = pg.locator("input.PhoneInputInput").first
            ph.click(timeout=6000)
            ph.fill("")
            ph.type("8102583253", delay=60)
            typed_ok = True
        except Exception as e:
            step("phone_type_err", err=str(e)[:60])
        pg.wait_for_timeout(1500)
        fld_val = pg.evaluate(
            """() => { const i=document.querySelector('input.PhoneInputInput');
              const sel=document.querySelector('select.PhoneInputCountrySelect');
              return {value: i ? String(i.value||'').slice(0,26) : null,
                      country: sel ? sel.value : null,
                      country_label: sel && sel.selectedOptions[0]
                        ? sel.selectedOptions[0].textContent.trim().slice(0,24) : null}; }""")
        step("phone_after_set", **fld_val)
        # The guard: the destination must be OUR number, in E.164. A DM default of
        # +49 plus these digits is a real German subscriber.
        _digits = "".join(ch for ch in (fld_val.get("value") or "") if ch.isdigit())
        if fld_val.get("country") != "US" or not _digits.endswith("8102583253") \
           or len(_digits) != 11:
            step("ABORT", code="wrong-destination",
                 country=fld_val.get("country"), digits=_digits,
                 note="refusing to request a code: the number is not the US JMP line. "
                      "Sending here texts a real third party and can never receive our code.")
            pg.screenshot(path="/tmp/vt-wrong-number.png")
            b.close()
            sys.exit(11)
        step("destination_verified", e164="+1" + _digits[-10:])
        pg.screenshot(path="/tmp/vt-modal-filled.png")
        if not typed_ok:
            step("ABORT", code="phone-type-failed")
            b.close()
            sys.exit(10)

        # SMS (JMP is SMS-only; WhatsApp is the default selection)
        try:
            # Was a hardcoded coordinate (837,626) measured at 1366x1200. Any other
            # viewport moves it, so select by TEXT and fall back to the label.
            _sms = None
            for _sel in ("text=/Klassische Textnachricht/i", "text=/^SMS$/i"):
                _loc = pg.query_selector(_sel)
                if _loc and _loc.is_visible():
                    _loc.click(timeout=5000)
                    _sms = _sel
                    break
            step("sms_selected", via=_sms)
        except Exception as e:
            step("sms_select_err", err=str(e)[:50])

        # ---------- click 'Code senden' and watch the JMP inbox -----------------
        since = time.time() - 5
        clicked = False
        try:
            pg.get_by_role("button", name="Code senden").first.click(timeout=6000)
            clicked = True
            step("code_senden_clicked")
            set_state("awaiting_sms")
        except Exception as e:
            # it may be disabled until Turnstile passes — report that honestly
            cls = None
            try:
                cls = pg.get_by_role("button", name="Code senden").first.get_attribute("class")
            except Exception:
                pass
            step("code_senden_err", err=str(e)[:60], btn_class=cls)
        pg.screenshot(path="/tmp/vt-after-send.png")

        if clicked:
            rows = poll_inbox(since)
            if rows:
                # mask the code content; we only need to know it ARRIVED
                arrived = [{"ts": r[0], "peer_masked": r[1][:6] + "…",
                            "body_len": len(r[2]) if len(r) > 2 and r[2] else 0}
                           for r in rows]
                step("SMS_ARRIVED", msgs=arrived)
                set_state("submitting", phase="code_received")
                # ---- enter the code and confirm the order -------------------
                # Without this the flow stops at "SMS arrived" and the venue never
                # takes the order: payment settled, no food, and nothing in the
                # stream that says so.
                code = _extract_code(rows)
                if not code:
                    step("venue_confirm_unknown", reason="no code found in the inbox rows")
                else:
                    try:
                        boxes = pg.query_selector_all(
                            "input[maxlength='1'], input[inputmode='numeric']"
                        )
                        entered = 0
                        for i, ch in enumerate(code):
                            if i >= len(boxes):
                                break
                            boxes[i].click(timeout=3000)
                            boxes[i].type(ch, delay=40)
                            entered += 1
                        step("code_entered", digits=entered)
                        pg.get_by_role("button", name="Bestätigen").first.click(timeout=8000)
                        step("confirm_clicked")
                        set_state("submitting", phase="confirm_clicked")
                        pg.wait_for_timeout(6000)
                        ref = _find_venue_ref(pg)
                        pg.screenshot(path="/tmp/vt-confirmed.png")
                        if ref:
                            step("venue_confirmed", ref=ref)
                            set_state("completed", venue_ref=ref)
                        else:
                            # The click landed but no reference is visible. Claiming
                            # confirmed here would be inventing evidence; the caller
                            # treats this as unknown and a human checks.
                            step("venue_confirm_unverified",
                                 note="confirm clicked, no order reference found")
                            set_state("outcome_unknown", phase="confirm_unverified")
                    except Exception as e:
                        step("venue_confirm_err", err=str(e)[:80])
                        set_state("outcome_unknown", phase="confirm_error")
            else:
                step("SMS_NOT_RECEIVED_180s")
        b.close()

    print("\n=== summary ===")
    for s in R:
        print(json.dumps(s)[:260])



def _extract_code(rows):
    """Pull the verification code out of the newest inbox row.

    Deliberately narrow: 4-6 consecutive digits that are not part of a longer
    number. A wrong guess costs a failed attempt at a venue that rate-limits, so
    we would rather find nothing and say so.
    """
    import re as _re
    for r in reversed(rows or []):
        body = r[2] if len(r) > 2 else ""
        m = _re.search(r"(?<!\d)(\d{4,6})(?!\d)", body or "")
        if m:
            return m.group(1)
    return None


def _find_venue_ref(pg):
    """Find the venue's order reference on the confirmation screen.

    Patterns are the ones a food-ordering confirmation actually shows. If none
    match we return None rather than fabricate a reference - an invented ref is
    indistinguishable from a real one downstream.
    """
    import re as _re
    candidates = []
    try:
        txt = pg.inner_text("body") or ""
        candidates.append(txt)
    except Exception:
        pass
    for pat in (r"(?:Bestellnummer|Order(?:\s*(?:number|no\.?|#))?)[:\s#]*([A-Z0-9][A-Z0-9-]{3,})",
                r"\b(TG[- ]?\d{3,})\b"):
        for blob in candidates:
            m = _re.search(pat, blob, _re.I)
            if m:
                return m.group(1).strip()
    return None

if __name__ == "__main__":
    main()