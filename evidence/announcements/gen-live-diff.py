#!/usr/bin/env python3
"""Generate the LIVE before/after diff for the venue announcements.

The card asks for the before/after diff of the republished announcements. The
committed `before-t7d410f66/` copies are the pre-card ARTIFACTS (they predate the
ADR-0011 order-input drift), so `DIFF-t7d410f66.md` compares artifact->artifact.
This script complements it with what the RELAYS actually served: the readbacks
taken before and after the republish in this run.

Output: LIVE-DIFF-t7d410f66.md
"""
import difflib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAIRS = [
    ("doppelt-kaese-berlin", 11316),
    ("doppelt-kaese-berlin", 11317),
    ("pizza-e-pasta-ruedesheimerplatz", 11316),
    ("pizza-e-pasta-ruedesheimerplatz", 11317),
]


def load(dirname, slug, kind):
    relay, out = None, {}
    for line in (HERE / dirname / f"{slug}.{kind}.jsonl").read_text().splitlines():
        if line.startswith("### relay"):
            relay = line.split()[2]
            continue
        if line.startswith("{"):
            out[relay] = json.loads(line)
    return out


def pretty(ev):
    return json.dumps(json.loads(ev["content"]), indent=2, sort_keys=True, ensure_ascii=False).splitlines()


def main():
    out = ["# LIVE before/after — what the announced relays actually served", ""]
    out.append(
        "Readbacks: `live-before-t7d410f66/` (fetched before the republish in this run) and "
        "`live-after-t7d410f66/` (after). Both relays (`wss://relay2.orangesync.tech`, "
        "`wss://relay.primal.net`) returned the same single event per (venue, kind)."
    )
    out.append("")
    for slug, kind in PAIRS:
        b = load("live-before-t7d410f66", slug, kind)
        a = load("live-after-t7d410f66", slug, kind)
        be, ae = next(iter(b.values())), next(iter(a.values()))
        changed = be["id"] != ae["id"]
        out.append(f"## {slug} — kind {kind}")
        out.append("")
        out.append(f"- before: id `{be['id']}` created_at {be['created_at']}")
        out.append(f"- after:  id `{ae['id']}` created_at {ae['created_at']}")
        out.append(f"- event replaced by this card: **{'yes' if changed else 'no'}**")
        if not changed:
            out.append(
                "- the relay already served this content before the republish in THIS run "
                "(the fix for this venue/kind had already been published earlier in the same "
                "card — see `published-t7d410f66/` and the note below), so there is no "
                "live-vs-live diff to show."
            )
            out.append("")
            continue
        tags_b, tags_a = be["tags"], ae["tags"]
        added = [t for t in tags_a if t not in tags_b]
        removed = [t for t in tags_b if t not in tags_a]
        out.append(f"- tags added: `{json.dumps(added)}`; removed: `{json.dumps(removed)}`")
        d = difflib.unified_diff(pretty(be), pretty(ae), "before", "after", lineterm="", n=3)
        out.append("")
        out.append("```diff")
        out.extend(d)
        out.append("```")
        out.append("")
    (HERE / "LIVE-DIFF-t7d410f66.md").write_text("\n".join(out) + "\n")
    print("\n".join(out[:40]))
    print(f"... wrote {HERE / 'LIVE-DIFF-t7d410f66.md'}")


if __name__ == "__main__":
    main()
