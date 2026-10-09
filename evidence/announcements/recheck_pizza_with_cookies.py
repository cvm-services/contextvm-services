#!/usr/bin/env python3
"""Retry the pizza rails with the committed browser cookie jar (cf_clearance),
because a plain GET is answered with the Cloudflare challenge (HTTP 403).

Prints HTTP status + sha256 only; never prints cookie values.

usage: recheck_pizza_with_cookies.py <cookiejson> <outdir>
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0 Safari/537.36"
)
URLS = {
    "myrestaurant-restaurant": "https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/restaurant/45842?timeSensitive=false",
    "myrestaurant-family": "https://pizzaepasta-ruedesheimerplatz.de/oyy-api/MyRestaurant/families/by-domain?domain=pizzaepasta-ruedesheimerplatz.de",
}
RECORDED = {
    "myrestaurant-restaurant": "0c2b47d92fd56258056c94999e920bca9ad76b1a51124307f5bd0c9761d1f0f2",
    "myrestaurant-family": "fc5193c14496035b6e391883c6a15674b12aab27e3e41b41cdafee5c0c9f674e",
}


def jar_from(json_path, jar_path):
    cookies = json.loads(Path(json_path).read_text())
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        dom = c.get("domain", "")
        lines.append("\t".join([
            dom,
            "TRUE" if dom.startswith(".") else "FALSE",
            c.get("path", "/"),
            "TRUE" if c.get("secure") else "FALSE",
            "0",
            c.get("name", ""),
            c.get("value", ""),
        ]))
    Path(jar_path).write_text("\n".join(lines) + "\n")
    Path(jar_path).chmod(0o600)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parent.parent / "venues/pizza-e-pasta-ruedesheimerplatz/evidence/cookies.json")
    outdir = Path(sys.argv[2] if len(sys.argv) > 2 else "recheck-t7d410f66")
    outdir.mkdir(parents=True, exist_ok=True)
    jar = outdir / "pizza-cookies.jar"
    jar_from(src, jar)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"# pizza rails retried with the committed cookie jar ({stamp})")
    for name, url in URLS.items():
        p = subprocess.run(
            ["curl", "-sS", "-A", UA, "-b", str(jar), "-c", str(jar),
             "-H", "Accept: application/json, text/plain, */*",
             "-H", "Accept-Language: de-DE,de;q=0.9,en;q=0.8",
             "--max-time", "45", "-w", "\n%{http_code}", url],
            capture_output=True,
        )
        body, _, code = p.stdout.rpartition(b"\n")
        sha = hashlib.sha256(body).hexdigest()
        print(f"- {name}: HTTP {code.decode()} bytes={len(body)} sha={sha[:16]}… recorded={RECORDED[name][:16]}… match={sha == RECORDED[name]}")
        (outdir / f"pizza.{name}.sha256").write_text(json.dumps({
            "url": url, "http_status": code.decode(), "fetched_at_utc": stamp,
            "sha256": sha, "bytes": len(body), "recorded_sha256": RECORDED[name],
            "match": sha == RECORDED[name], "with_cookie_jar": True,
        }, indent=1) + "\n")


if __name__ == "__main__":
    main()
