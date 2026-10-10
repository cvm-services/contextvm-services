#!/usr/bin/env python3
"""capture_menu.py -- declarative menu capture for a CLASS-1 venue (deep link + human).

WHY THIS EXISTS
---------------
`venues/<slug>/adapter.py` talks to ONE platform's private JSON API, so it is a
per-venue CODE file (FoodAmigos, OrderYoyo, ...). A class-1 venue has no ordering
API at all: it publishes its prices as text or PDF on its own website and takes
the order from a human (phone / walk-in / its own web shop). Onboarding such a
venue must be **pure configuration**, so this is the ONE shared tool that turns
that configuration into a captured menu. Adding a class-1 venue adds a
`venue.json` and nothing else -- no file here changes.

The venue's `venue.json` declares a `capture` block:

    "capture": {
      "url": "https://venue.example/speisekarte",
      "extractor": "html_block_text",        // or "pdf_text"
      "price_method": "dine_in",
      "mode": "pair",                        // "inline" (default) or "pair"
      "item_line_pattern": "^(?P<sku>\\d{1,3})\\.?\\s+(?P<name>...)$",
      "price_line_pattern": "^(?P<price>\\d{1,3}[.,]\\d{2})$",   // pair mode only
      "section_names": ["Suppen", "Vorspeisen"],
      "section_line_pattern": "...",         // used when section_names is absent
      "sku_from": "leading-number",
      "fragments": [["Tomatencremesuppe", 400]],
      "service_method_note": "...",
      "sku_policy_note": "...",
      "source_note": "..."
    }

and this tool writes, from it:

    evidence/raw/page.txt        canonical text of the venue's own page (redacted)
    evidence/raw/source.json     url, http status, bytes, sha256 of the RAW
                                 (unredacted) response, captured_at, extractor
    evidence/fragments/*.txt     verbatim byte-slices of page.txt (PR-readable)
    venue.json                   the `menu` block, rebuilt from that capture

Nothing is OCR'd, inferred or typed by hand: every item and price is a line of
the venue's own page that matched the venue's own declared pattern. Lines that
match neither pattern are counted (`stats.unparsed_lines`) and never silently
dropped into the record.

REDACTION (venues/README.md rule 5). Committed evidence is passed through a
documented redaction list -- owner e-mail addresses and phone numbers -- while
`source.json` keeps the sha256 of the *unredacted* response so provenance stays
checkable by whoever is entitled to re-fetch it.

USAGE
-----
  python3 venues/tools/capture_menu.py --venue venues/<slug>/venue.json --fetch
  python3 venues/tools/capture_menu.py --venue venues/<slug>/venue.json --check

`--check` refetches nothing: it re-derives the menu from the committed evidence
and fails when the on-disk `menu` block differs (idempotence).

Exit codes: 0 ok, 1 verification failed, 2 fetch/parse error.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "cvm-services-venue-adapter/1.0 (+https://github.com/cvm-services/contextvm-services)"

# --- html -> menu lines -----------------------------------------------------
# Block-level tags: a menu is a list of lines, so keep those boundaries instead
# of flattening the page into one unparseable string.
BLOCK_TAG_RE = re.compile(
    r"(?i)</?(?:p|div|li|tr|td|th|h[1-6]|section|article|ul|ol|table|tbody|br|hr|dd|dt|dl|figure|figcaption|span|strong|em|b|i)\b[^>]*>"
)
DROP_ELEMENTS_RE = re.compile(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1\s*>")
TAG_RE = re.compile(r"(?s)<[^>]+>")

# --- redaction --------------------------------------------------------------
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# A phone in this corpus starts with a country code (+49) or a national trunk 0.
# Anchoring on that is what keeps additive-code runs like "13.14.15.16." and
# prices like "0,80" out of the redaction (both were false positives before).
PHONE_CANDIDATE_RE = re.compile(r"(?<![\d])(?:\+49|\+?\d{1,4}\s?\(0\)|0)\d[\d\s()/.\-\u2013\u2014]{5,}\d")
PHONE_MIN_DIGITS = 9  # a Berlin landline has 11; the longest menu price has 3


def redact(text: str) -> tuple[str, dict]:
    """Documented redaction of PII in committed evidence (README rule 5)."""
    counts = {"email": 0, "phone": 0}

    def _email(_m: re.Match) -> str:
        counts["email"] += 1
        return "[redacted-email]"

    text = EMAIL_RE.sub(_email, text)

    def _phone(m: re.Match) -> str:
        digits = sum(c.isdigit() for c in m.group(0))
        if digits < PHONE_MIN_DIGITS:
            return m.group(0)
        # never redact a line that is a price
        if re.search(r"\d\s*(?:\u20ac|EUR)\s*$", m.group(0)):
            return m.group(0)
        counts["phone"] += 1
        return "[redacted-phone]"

    text = PHONE_CANDIDATE_RE.sub(_phone, text)
    return text, counts


def slugify(text: str) -> str:
    t = text.lower().replace("\u00e4", "ae").replace("\u00f6", "oe").replace("\u00fc", "ue")
    t = t.replace("\u00df", "ss")
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return re.sub(r"-{2,}", "-", t)[:60]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def http_get(url: str, timeout: int = 60) -> tuple[bytes, int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), int(resp.status), str(resp.headers.get("Content-Type", ""))


# --- extractors -------------------------------------------------------------

def extract_block_text(body: str) -> str:
    """HTML -> one menu line per line, deterministically."""
    body = DROP_ELEMENTS_RE.sub(" ", body)
    body = BLOCK_TAG_RE.sub("\n", body)
    body = TAG_RE.sub(" ", body)
    body = html.unescape(body)
    lines = []
    for raw_line in body.split("\n"):
        line = re.sub(r"[ \t\u00a0]+", " ", raw_line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines) + "\n"


def extract_pdf_text(body: bytes) -> str:
    """PDF -> layout text via poppler's pdftotext (the venue's own document)."""
    with tempfile.TemporaryDirectory() as td:
        pdf = Path(td) / "doc.pdf"
        pdf.write_bytes(body)
        out = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"],
            capture_output=True, check=True,
        ).stdout.decode("utf-8", "replace")
    out = out.replace("\f", "\n")
    lines = []
    for raw_line in out.split("\n"):
        line = re.sub(r"[ \t\u00a0]+", " ", raw_line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines) + "\n"


EXTRACTORS = {"html_block_text": "html", "pdf_text": "pdf"}


def extract(capture: dict, body: bytes) -> str:
    kind = EXTRACTORS.get(capture["extractor"])
    if kind == "html":
        return extract_block_text(body.decode("utf-8", "replace"))
    if kind == "pdf":
        return extract_pdf_text(body)
    raise RuntimeError(f"unknown extractor {capture['extractor']!r}")


# --- parsers ----------------------------------------------------------------

def _sku_for(name: str, groups: dict, sku_from: str) -> tuple[str, str]:
    if groups.get("sku"):
        return str(groups["sku"]).strip().rstrip("."), name
    if sku_from == "leading-number":
        num = re.match(r"^(\d{1,3})[.)]?\s+(.*)$", name)
        if num:
            return num.group(1), num.group(2).strip(" .-\u2013\u2014")
    return slugify(name), name


def parse_items(text: str, capture: dict) -> dict:
    item_re = re.compile(capture["item_line_pattern"])
    price_re = re.compile(capture["price_line_pattern"]) if capture.get("price_line_pattern") else None
    section_names = {s.strip() for s in capture.get("section_names", [])}
    sec_re = re.compile(capture["section_line_pattern"]) if capture.get("section_line_pattern") else None
    skip_lines = {s.strip() for s in capture.get("skip_lines", [])}
    stop_before = {s.strip() for s in capture.get("stop_before", [])}
    sku_from = capture.get("sku_from", "none")
    method = capture["price_method"]

    sections: list[dict] = []
    items: list[dict] = []
    unparsed: list[str] = []
    seen_skus: dict[str, int] = {}
    current = None
    pending: tuple[str, dict] | None = None  # pair mode: name line awaiting its price line

    def emit(name: str, groups: dict, price: float, source_line: str) -> None:
        nonlocal current
        sku, name = _sku_for(name, groups, sku_from)
        name = re.sub(r"\s+", " ", name).strip(" .-\u2013\u2014")
        if not name or not sku:
            unparsed.append(source_line)
            return
        seen_skus[sku] = seen_skus.get(sku, 0) + 1
        if seen_skus[sku] > 1:
            sku = f"{sku}-{seen_skus[sku]}"
        items.append({
            "id": sku,
            "sku": sku,
            "name": name,
            "price": price,
            "currency": "EUR",
            "prices_by_order_method": {method: price},
            "available": True,
            "allergens": None,
            "option_group_ids": [],
            "section_ids": [current["id"]] if current else [],
            "image_url": None,
            "listed_in_menu": True,
            "source": "venue-site-page",
        })
        if current is not None:
            current["item_skus"].append(sku)

    def open_section(name: str) -> None:
        nonlocal current
        sec_id = slugify(name)
        for s in sections:
            if s["id"] == sec_id:  # a section continued on a later page is the same section
                current = s
                return
        current = {"id": sec_id, "name": name, "kind": "menu_section", "item_skus": []}
        sections.append(current)

    lines = text.split("\n")
    if capture.get("start_after"):
        marker = str(capture["start_after"]).strip()
        last = max((i for i, l in enumerate(lines) if l.strip() == marker), default=-1)
        lines = lines[last + 1:]

    for line in lines:
        if not line.strip():
            continue
        if line in stop_before:
            break  # the venue's own page says where the menu ends
        if line in skip_lines:
            continue  # declared page furniture that sits inside the list
        # A line that IS a price line closes a pending pair; on its own it is noise.
        if price_re and price_re.match(line):
            price = float(price_re.match(line).group("price").replace(",", "."))
            if pending is not None:
                raw_line, groups = pending
                emit(groups.get("name") or raw_line, groups, price, raw_line)
                pending = None
                continue
            unparsed.append(line)
            continue
        # A declared section name wins over the item pattern: in a two-line menu
        # ("HAMBURGER" / "6 EUR") a permissive item pattern would otherwise eat
        # the header. The names are verbatim lines of the venue's own page.
        if line in section_names:
            if pending is not None:
                unparsed.append(pending[0])
                pending = None
            open_section(line)
            continue
        m = item_re.match(line)
        if m:
            if pending is not None:
                unparsed.append(pending[0])  # a name line with no price: not orderable
                pending = None
            groups = m.groupdict()
            if groups.get("price"):
                emit(groups["name"], groups, float(groups["price"].replace(",", ".")), line)
            else:
                pending = (line, groups)
            continue
        if sec_re and sec_re.match(line):
            if pending is not None:
                unparsed.append(pending[0])
                pending = None
            open_section(sec_re.match(line).group("section").strip())
            continue
        unparsed.append(line)

    if pending is not None:
        unparsed.append(pending[0])

    # FAIL CLOSED on a mis-parse. A line that carries two prices (a wine listed by
    # the glass and by the bottle) can make a non-greedy name pattern swallow the
    # first price. Rather than serve an item whose *name* contains a price, the
    # item is quarantined: counted, reported, and not emitted.
    price_in_name = re.compile(r"\d{1,3}[.,]\d{2}\s*(?:\u20ac|EUR)")
    clean: list[dict] = []
    quarantined: list[str] = []
    for item in items:
        if price_in_name.search(item["name"]):
            quarantined.append(f'{item["sku"]} | {item["name"]} | {item["price"]}')
            for s in sections:
                if item["sku"] in s["item_skus"]:
                    s["item_skus"].remove(item["sku"])
            continue
        clean.append(item)
    items = clean
    unparsed.extend(quarantined)

    priced = [i["price"] for i in items]
    order = {it["sku"]: n for n, it in enumerate(items)}
    # A section is listed where its first item is, so the record reads in the
    # venue's own order even when the page repeats a heading (a nav teaser).
    live_sections = sorted(
        (s for s in sections if s["item_skus"]),
        key=lambda s: order.get(s["item_skus"][0], 1 << 30),
    )
    return {
        "sections": live_sections,
        "items": items,
        "unparsed_lines": unparsed,
        "stats": {
            "sections": len(live_sections),
            "items_listed": len(items),
            "items_priced_listed": len(priced),
            "min_price_listed": min(priced) if priced else None,
            "max_price_listed": max(priced) if priced else None,
            "quarantined_items": len(quarantined),
            "unparsed_line_count": len(unparsed),
        },
    }


def canonical_json(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_menu(venue: dict, capture: dict, text: str, source: dict) -> dict:
    parsed = parse_items(text, capture)
    return {
        "currency": "EUR",
        "captured_at": source["captured_at"],
        "generated_by": "venues/tools/capture_menu.py",
        "service_method": capture["price_method"],
        "service_method_note": capture["service_method_note"],
        "sku_policy": capture["sku_policy_note"],
        "availability_note": (
            "the venue publishes this list as its current offering; availability is declared "
            "true from that publication, not from a stock API (no stock API exists)"
        ),
        "sections": parsed["sections"],
        "items": parsed["items"],
        "stats": parsed["stats"],
        "source": {
            "url": source["url"],
            "captured_at": source["captured_at"],
            "sha256_response": source["sha256_response"],
            "bytes": source["bytes"],
            "extractor": capture["extractor"],
            "note": capture["source_note"],
        },
    }


def write_fragments(text: str, out_dir: Path, specs: list) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.txt"):
        old.unlink()
    written = []
    body = text.encode("utf-8")
    for anchor, length in specs:
        idx = body.find(anchor.encode("utf-8"))
        if idx < 0:
            raise RuntimeError(f"declared fragment anchor {anchor!r} is not in the capture; "
                               "fix the config instead of committing evidence without it")
        frag = body[idx:idx + length]
        decoded = frag.decode("utf-8", "replace")
        if EMAIL_RE.search(decoded):
            raise RuntimeError(f"fragment {anchor!r} would leak an e-mail; move the anchor")
        if "[redacted-phone]" in decoded:
            raise RuntimeError(f"fragment {anchor!r} overlaps a redacted phone; move the anchor")
        name = f"{slugify(anchor)[:44]}.txt"
        (out_dir / name).write_bytes(frag)
        written.append(name)
    return written


def run(args) -> int:
    venue_path = Path(args.venue)
    if not venue_path.is_absolute():
        venue_path = (Path.cwd() / venue_path).resolve()
    raw = json.loads(venue_path.read_text(encoding="utf-8"))
    slug = raw["slug"]
    capture = raw.get("capture")
    if not isinstance(capture, dict):
        print(f"FAIL: {venue_path} declares no capture block", file=sys.stderr)
        return 2
    raw_dir = venue_path.parent / "evidence" / "raw"
    frag_dir = venue_path.parent / "evidence" / "fragments"
    source_path = raw_dir / "source.json"

    if args.fetch or not (raw_dir / "page.txt").exists():
        if args.reparse:
            print("FAIL: --reparse needs committed evidence; none on disk", file=sys.stderr)
            return 2
        body, status, content_type = http_get(capture["url"])
        if status != 200:
            print(f"FAIL: HTTP {status} for {capture['url']}", file=sys.stderr)
            return 2
        text, redactions = redact(extract(capture, body))
        raw_dir.mkdir(parents=True, exist_ok=True)
        (raw_dir / "page.txt").write_bytes(text.encode("utf-8"))
        source = {
            "url": capture["url"],
            "http_status": status,
            "content_type": content_type,
            "bytes": len(body),
            "sha256_response": sha256_hex(body),
            "sha256_canonical_text": sha256_hex(text.encode("utf-8")),
            "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "extractor": capture["extractor"],
            "user_agent": USER_AGENT,
            "redactions_applied": redactions,
            "redaction_policy": "venues/README.md rule 5 (owner e-mail addresses and phone numbers)",
        }
        source_path.write_bytes(canonical_json(source))
        write_fragments(text, frag_dir, [tuple(s) for s in capture.get("fragments", [])])
    else:
        source = json.loads(source_path.read_text(encoding="utf-8"))

    text = (raw_dir / "page.txt").read_text(encoding="utf-8")
    menu = build_menu(raw, capture, text, source)

    if args.check:
        rebuilt = canonical_json({**raw, "menu": menu})
        on_disk = canonical_json(raw)
        if raw.get("menu") is None or on_disk != rebuilt:
            print(
                f"CHECK FAIL {slug}: on-disk menu differs from the rebuild "
                f"(on-disk={sha256_hex(on_disk)[:12]} rebuilt={sha256_hex(rebuilt)[:12]})",
                file=sys.stderr,
            )
            return 1
        print(
            f"CHECK OK {slug} items={menu['stats']['items_listed']} "
            f"sections={menu['stats']['sections']} captured_at={menu['captured_at']} "
            f"sha256={sha256_hex(rebuilt)[:12]}"
        )
        return 0

    raw["menu"] = menu
    venue_path.write_bytes(canonical_json(raw))
    print(
        f"CAPTURED {slug} items={menu['stats']['items_listed']} "
        f"sections={menu['stats']['sections']} unparsed={menu['stats']['unparsed_line_count']} "
        f"min={menu['stats']['min_price_listed']} max={menu['stats']['max_price_listed']} "
        f"captured_at={menu['captured_at']}"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="declarative menu capture (class-1 venues)")
    ap.add_argument("--venue", required=True, help="path to venues/<slug>/venue.json")
    ap.add_argument("--fetch", action="store_true", help="re-fetch from the venue's page")
    ap.add_argument("--reparse", action="store_true", help="rebuild from committed evidence (no network)")
    ap.add_argument("--check", action="store_true", help="rebuild and compare with venue.json (no write)")
    args = ap.parse_args()
    try:
        return run(args)
    except (urllib.error.URLError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
