#!/usr/bin/env python3
"""Re-fetch the venue rails this card's facts came from and compare the payload
hash with the one recorded in `source.calls` at capture time.

A matching sha256 means the declared fulfilment facts are still what the rail
publishes (the provenance block stays valid); a mismatch means the venue record
is stale and needs re-derivation. Read-only: GETs public endpoints, writes only
under `rail-recheck/`.

usage: recheck_rail.py <outdir>
"""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0 Safari/537.36"
)

TARGETS = [
    # (venue slug, call name recorded in venue.json source.calls)
    ("doppelt-kaese-berlin", "company"),
    ("doppelt-kaese-berlin", "store"),
    ("pizza-e-pasta-ruedesheimerplatz", "myrestaurant-restaurant"),
    ("pizza-e-pasta-ruedesheimerplatz", "myrestaurant-family"),
]


def main():
    outdir = Path(sys.argv[1] if len(sys.argv) > 1 else "rail-recheck")
    outdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for slug, call in TARGETS:
        venue = json.loads((HERE.parent.parent / "venues" / slug / "venue.json").read_text())
        rec = venue["source"]["calls"][call]
        url = rec["url"]
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        p = subprocess.run(
            ["curl", "-sS", "-A", UA, "--max-time", "45", "-w", "\n%{http_code}", url],
            capture_output=True,
        )
        if p.returncode != 0:
            rows.append((slug, call, url, "FETCH-FAILED", p.stderr.decode()[:200], stamp))
            continue
        body, _, code = p.stdout.rpartition(b"\n")
        sha = hashlib.sha256(body).hexdigest()
        matches = sha == rec.get("sha256")
        rows.append((slug, call, url, code.decode(), f"sha={sha[:16]}… recorded={rec.get('sha256','')[:16]}… match={matches}", stamp))
        (outdir / f"{slug}.{call}.sha256").write_text(
            json.dumps({
                "url": url, "http_status": code.decode(), "fetched_at_utc": stamp,
                "sha256": sha, "bytes": len(body),
                "recorded_sha256": rec.get("sha256"), "match": matches,
            }, indent=1) + "\n"
        )
    lines = ["# Rail re-check (payload hash vs provenance block)", ""]
    for slug, call, url, code, note, stamp in rows:
        lines.append(f"- {slug} / {call}: HTTP {code} — {note}  ({stamp})")
        lines.append(f"  {url}")
    text = "\n".join(lines) + "\n"
    (outdir / "RECHECK.md").write_text(text)
    print(text)
    return 0 if all("match=True" in r[4] for r in rows if r[3] != "FETCH-FAILED") else 1


if __name__ == "__main__":
    sys.exit(main())
