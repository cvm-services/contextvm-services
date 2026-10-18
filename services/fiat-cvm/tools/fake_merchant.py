#!/usr/bin/env python3
"""A FAKE MERCHANT checkout, for proving the capture mechanism at $0.

Why: a real charge costs money and cannot be undone, and the mechanism (fill a
merchant's hosted card form, submit, handle a step-up) is not written yet. This
local page stands in for a restaurant's checkout so the *mechanism* can be proven
end to end with SYNTHETIC card values.

It deliberately mimics the shape of the real thing:
  * card number, expiry and CVV in separate inputs (as hosted fields are)
  * a submit button disabled until the fields look plausible
  * an optional 3-D Secure step that asks for a 6-digit code

It records ONLY:
  * whether each field was filled and its LENGTH
  * whether the PAN passes a Luhn check
  * whether the CVV is 3-4 digits
It NEVER records the values themselves — not to stdout, not to disk. That keeps the
harness honest: it can prove "a valid card was submitted" without becoming a place
where card data accumulates.

Run:  python3 fake_merchant.py --port 8099
"""
import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Fake Merchant Checkout</title>
<style>
 body{font-family:system-ui;max-width:420px;margin:40px auto}
 label{display:block;margin:12px 0 4px;font-size:13px;color:#444}
 input{width:100%;padding:10px;font-size:15px;border:1px solid #bbb;border-radius:6px}
 button{margin-top:18px;width:100%;padding:12px;font-size:15px;border:0;border-radius:6px;
        background:#d33;color:#fff}
 button:disabled{background:#ccc}
 .row{display:flex;gap:10px}
 .row>div{flex:1}
 #msg{margin-top:14px;font-size:14px}
</style></head><body>
<h2>Fake Merchant — pay &euro;10.65</h2>
<form id="f">
  <label for="cn">Card number</label>
  <input id="cn" name="cardnumber" autocomplete="cc-number" inputmode="numeric">
  <div class="row">
    <div><label for="ex">Expiry</label><input id="ex" name="expiry" placeholder="MM/YY"></div>
    <div><label for="cv">CVV</label><input id="cv" name="cvv" inputmode="numeric"></div>
  </div>
  <button id="pay" type="submit" disabled>Pay &euro;10.65</button>
</form>
<div id="msg"></div>
<script>
 const cn=document.getElementById('cn'), ex=document.getElementById('ex'),
       cv=document.getElementById('cv'), pay=document.getElementById('pay'),
       msg=document.getElementById('msg');

 function luhn(n){let s=0,alt=false;for(let i=n.length-1;i>=0;i--){let d=+n[i];
   if(alt){d*=2;if(d>9)d-=9}s+=d;alt=!alt}return n.length>=13&&s%10===0}
 function refresh(){
   const ok = luhn(cn.value.replace(/\\s/g,'')) && /^\\d{2}\\/\\d{2}$/.test(ex.value)
              && /^\\d{3,4}$/.test(cv.value);
   pay.disabled = !ok;
 }
 [cn,ex,cv].forEach(e=>e.addEventListener('input',refresh));

 document.getElementById('f').addEventListener('submit', async (e)=>{
   e.preventDefault();
   msg.textContent='Submitting…';
   const r = await fetch('/charge',{method:'POST',headers:{'content-type':'application/json'},
     body: JSON.stringify({cardnumber:cn.value, expiry:ex.value, cvv:cv.value})});
   const j = await r.json();
   if (j.step_up) {
     msg.innerHTML = '3-D Secure required. Enter the code: <input id="otp" style="width:120px">' +
                     ' <button id="v" type="button">Verify</button>';
     document.getElementById('v').onclick = async ()=>{
       const r2 = await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},
         body: JSON.stringify({code:document.getElementById('otp').value})});
       const j2 = await r2.json();
       msg.textContent = j2.status === 'captured' ? 'CAPTURED ' + j2.reference : 'FAILED ' + j2.status;
     };
   } else {
     msg.textContent = j.status === 'captured' ? 'CAPTURED ' + j.reference : 'FAILED ' + j.status;
   }
 });
</script></body></html>"""


def luhn_ok(n: str) -> bool:
    digits = [int(c) for c in n if c.isdigit()]
    if len(digits) < 13:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


class H(BaseHTTPRequestHandler):
    step_up = False

    def log_message(self, format, *args):  # noqa: A002
        pass  # keep stdout clean; we print our own summaries

    def _send(self, code: int, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/checkout"):
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            body = json.loads(raw or "{}")
        except Exception:
            body = {}

        if self.path == "/charge":
            pan_raw = re.sub(r"\D", "", str(body.get("cardnumber", "")))
            cvv_raw = re.sub(r"\D", "", str(body.get("cvv", "")))
            expiry = str(body.get("expiry", ""))
            # Report SHAPE only. Never the values.
            print(json.dumps({
                "event": "charge_attempt",
                "pan_len": len(pan_raw),
                "pan_luhn_valid": luhn_ok(pan_raw),
                "pan_is_test_number": pan_raw.startswith("4111"),
                "cvv_len": len(cvv_raw),
                "expiry_shape_ok": bool(re.match(r"^\d{2}/\d{2}$", expiry)),
            }), flush=True)

            if not luhn_ok(pan_raw) or not (3 <= len(cvv_raw) <= 4):
                self._send(400, b'{"status":"declined","reason":"invalid card"}')
                return
            if H.step_up:
                self._send(200, b'{"step_up":true}')
                return
            self._send(200, b'{"status":"captured","reference":"FAKE-REF-0001"}')
            return

        if self.path == "/verify":
            code = re.sub(r"\D", "", str(body.get("code", "")))
            ok = code == "654321"
            print(json.dumps({"event": "otp_verify", "code_len": len(code), "ok": ok}), flush=True)
            if ok:
                self._send(200, b'{"status":"captured","reference":"FAKE-REF-0002"}')
            else:
                self._send(200, b'{"status":"declined"}')
            return

        self._send(404, b'{"error":"not found"}')


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--step-up", action="store_true", help="require a 3-D Secure code")
    a = ap.parse_args()
    H.step_up = a.step_up
    print(f"fake merchant on http://127.0.0.1:{a.port} (step_up={a.step_up})", flush=True)
    HTTPServer(("127.0.0.1", a.port), H).serve_forever()
