#!/usr/bin/env python3
"""Compare the four venue announcements across three sources.

  live-before  — what the relays actually served (fetch-live-announcements.sh)
  committed    — evidence/announcements/before-t7d410f66/ (pre-card artifacts)
  regenerated  — evidence/announcements/<slug>.<kind>.json (current emitter, dry-run)

Prints, per (venue, kind): whether live == committed and whether live ==
regenerated, and the *content* leaves that differ between live and regenerated
(a JSON-pointer-ish path list), so the card's before/after claim is stated
against what the relays actually hold, not against a stale artifact.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEFORE = HERE / "before-t7d410f66"
# Which readback to judge: `live-before-t7d410f66` (default) or
# `live-after-t7d410f66` (after the republish). Pass the dir name as argv[1].
LIVE = HERE / (sys.argv[1] if len(sys.argv) > 1 else "live-before-t7d410f66")
PAIRS = [
    ("doppelt-kaese-berlin", 11316),
    ("doppelt-kaese-berlin", 11317),
    ("pizza-e-pasta-ruedesheimerplatz", 11316),
    ("pizza-e-pasta-ruedesheimerplatz", 11317),
]


def load_live(slug, kind):
    """One event per relay; both relays must agree. Returns (event, relays)."""
    path = LIVE / f"{slug}.{kind}.jsonl"
    evs, relay = [], None
    for line in path.read_text().splitlines():
        if line.startswith("### relay"):
            relay = line.split()[2]
            continue
        if line.startswith("{"):
            evs.append((relay, json.loads(line)))
    ids = {e["id"] for _, e in evs}
    if len(ids) != 1:
        raise SystemExit(f"{slug} {kind}: relays disagree, ids={ids}")
    return evs[0][1], [r for r, _ in evs]


def load_artifact(path):
    d = json.loads(Path(path).read_text())
    return d


def content_of(ev):
    c = ev["content"]
    return json.loads(c) if isinstance(c, str) else c


def diff_paths(a, b, path=""):
    """Leaf-level differences between two parsed JSON values."""
    out = []
    if type(a) is not type(b):
        return [(path or "/", f"{type(a).__name__} != {type(b).__name__}")]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append((f"{path}/{k}", "MISSING -> present"))
            elif k not in b:
                out.append((f"{path}/{k}", "present -> MISSING"))
            else:
                out += diff_paths(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list):
        if a != b and len(a) == len(b):
            for i, (x, y) in enumerate(zip(a, b)):
                out += diff_paths(x, y, f"{path}/{i}")
        elif a != b:
            out.append((path or "/", f"list {len(a)} -> {len(b)}"))
    elif a != b:
        out.append((path or "/", f"{json.dumps(a, ensure_ascii=False)[:120]} -> {json.dumps(b, ensure_ascii=False)[:120]}"))
    return out


def main():
    ok = True
    for slug, kind in PAIRS:
        live, relays = load_live(slug, kind)
        committed_path = BEFORE / f"{slug}.{kind}.json"
        regen_path = HERE / f"{slug}.{kind}.json"
        committed, regen = load_artifact(committed_path), load_artifact(regen_path)

        lc, cc, rc = content_of(live), content_of(committed), content_of(regen)
        lt, ct, rt = live["tags"], committed["tags"], regen["tags"]

        print(f"\n=== {slug} — kind {kind}")
        print(f"  live      id={live['id'][:16]} created_at={live['created_at']} relays={relays}")
        print(f"  live content == committed content : {lc == cc}")
        print(f"  live content == regenerated content: {lc == rc}")
        print(f"  live tags    == committed tags    : {lt == ct}")
        print(f"  live tags    == regenerated tags  : {lt == rt}")
        if lc != rc:
            d = diff_paths(lc, rc)
            print(f"  live -> regenerated content diffs ({len(d)} leaves):")
            for p, v in d:
                print(f"    {p}: {v}")
        if lt != rt:
            only_live = [t for t in lt if t not in rt]
            only_regen = [t for t in rt if t not in lt]
            print(f"  tags only live: {only_live}")
            print(f"  tags only regenerated: {only_regen}")
        print(f"  note: match against committed=={lc == cc}; card claim must use live")
        ok = ok and (lc == cc or lc == rc)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
