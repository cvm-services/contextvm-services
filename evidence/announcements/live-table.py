#!/usr/bin/env python3
"""Emit the authoritative before/after table for the venue announcements.

Reads the two readbacks (live-before-t7d410f66 / live-after-t7d410f66) and the
emitter artifacts, and prints one row per (venue, kind) with the event id that
the relays serve before and after the card, whether the two differ, and whether
the live event equals what the tree's emitter produces.
"""
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAIRS = [
    ("doppelt-kaese-berlin", 11316),
    ("doppelt-kaese-berlin", 11317),
    ("pizza-e-pasta-ruedesheimerplatz", 11316),
    ("pizza-e-pasta-ruedesheimerplatz", 11317),
]


def load(dirname, slug, kind):
    path = HERE / dirname / f"{slug}.{kind}.jsonl"
    relay, out = None, {}
    for line in path.read_text().splitlines():
        if line.startswith("### relay"):
            relay = line.split()[2]
            continue
        if line.startswith("{"):
            e = json.loads(line)
            out[relay] = e
    return out


def canon(ev):
    return json.dumps({"tags": ev["tags"], "content": ev["content"]}, sort_keys=True)


def main():
    print("# Live announcement state — card t_7d410f66 (authoritative)")
    print()
    print("| venue | kind | before (relay) | after (relay) | changed | live == emitter |")
    print("|---|---|---|---|---|---|")
    rows = []
    for slug, kind in PAIRS:
        b = load("live-before-t7d410f66", slug, kind)
        a = load("live-after-t7d410f66", slug, kind)
        bi = sorted({e["id"] for e in b.values()})
        ai = sorted({e["id"] for e in a.values()})
        assert len(bi) == 1 and len(ai) == 1, f"{slug} {kind}: relays disagree"
        art = json.loads((HERE / f"{slug}.{kind}.json").read_text())
        amap = json.dumps({"tags": art["tags"], "content": art["content"]}, sort_keys=True)
        av = next(iter(a.values()))
        live_eq = canon(av) == amap
        print(
            f"| {slug} | {kind} | `{bi[0][:16]}` | `{ai[0][:16]}` | "
            f"{'YES' if bi != ai else 'no'} | {'YES' if live_eq else 'NO'} |"
        )
        rows.append((slug, kind, bi[0], ai[0], av["created_at"]))
    print()
    print("Full event ids and the relays that served each readback:")
    for slug, kind, bid, aid, created in rows:
        print(f"- {slug} kind {kind}: after id `{aid}` created_at {created}")
        if bid != aid:
            print(f"    replaced: `{bid}`")
    print()
    print("content sha256 of the live (after) events:")
    for slug, kind in PAIRS:
        a = load("live-after-t7d410f66", slug, kind)
        ev = next(iter(a.values()))
        h = hashlib.sha256(ev["content"].encode()).hexdigest()
        print(f"- {slug} {kind}: {h}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
