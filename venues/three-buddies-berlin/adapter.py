#!/usr/bin/env python3
"""threebuddies.de -> venue.json  (CVM venue adapter, per ADR-0007)

WHAT THIS DOES
--------------
Three Buddies Steglitz (Albrechtstraße 131, 12167 Berlin) is on the same
FoodAmigos "storefront" platform as our first venue (doppelt-kaese-berlin): the
served HTML contains no prices, and the menu is fetched client-side. A headed
browser on the venue's own ordering route shows the JSON calls that carry the
venue record (verified 2026-10-11, see evidence/requests.json):

  1. GET https://www.threebuddies.de/api/store
       -> storefront payload (store id 481, name/address/quarter, has_pickup,
          has_delivery, franchise_slug, and `companies[*]` -> company id 509)
  2. GET https://app.foodamigos.io/api/companies/threebuddies/data?hostname=www.threebuddies.de
       -> company payload: company id **550**, franchise id 539, lat/lon,
          legal address, work schedule, delivery zones, payment gateways
  3. GET https://app.foodamigos.io/api/companies/550/menus
       -> menus, categories, products (base_price + order_method_prices),
          modifier groups, allergens/additives

All three answer plain unauthenticated GETs, so this adapter re-fetches them with
urllib (no browser, no OCR) and normalises them into ONE canonical venue record.

THE COMPANY-ID TRAP THIS VENUE SETS (and how it is resolved)
-----------------------------------------------------------
The storefront payload binds store 481 to company **509**. The franchise-level
company payload returns company **550**. BOTH ids answer `/menus` with HTTP 200,
and company 509's menu is a *different, non-burger* menu (Kofta/Qutab items) that
this venue does not serve. A naive "use the id from the store" adapter would
publish the wrong menu.

The browser capture is the tie-breaker and is committed as evidence: the venue's
own ordering route (`/speisekarte/threebuddies`) requests
`/api/companies/550/menus`, and the prices it RENDERS (see
`--verify-rendered`) match 550's `base_price`/`order_method_prices`, not 509's.
This adapter therefore follows the platform's own chain — store -> franchise_slug
-> `/companies/<slug>/data` -> `company.id` (= 550) -> `/menus` — and records the
509/550 discrepancy in the record itself (`venue.company_binding`) rather than
hiding it.

Every price in venue.json comes from `base_price` / `order_method_prices` of the
product objects returned by call 3. Nothing is inferred, nothing is OCR'd.

USAGE
-----
  python3 adapter.py                # fetch (if needed), write evidence + venue.json
  python3 adapter.py --fetch        # force re-fetch from the network
  python3 adapter.py --check        # rebuild from committed evidence, verify hash
  python3 adapter.py --selftest     # determinism + invariant assertions
  python3 adapter.py --write-anchor # (re)write evidence/anchor/page-price-anchor.json
                                    # from the rendered page dump
  python3 adapter.py --anchor evidence/anchor/page-price-anchor.json
                                    # NON-VACUOUS check: compare the record's prices
                                    # against the committed, page-derived anchor
  python3 adapter.py --negative-test
                                    # perturb a price and prove the anchor check FAILS
  python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
                                    # parse the page dump directly and compare

Exit codes: 0 ok, 1 verification failed, 2 network/build error.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

CONFIG = {
    "slug": "three-buddies-berlin",
    "domain": "threebuddies.de",
    # The venue's OWN storefront. `https://threebuddies.de/api/store` answers
    # HTTP 308 and redirects here (Vercel apex -> www); the platform mirror
    # `https://storefront.foodamigos.io/api/stores/threebuddies.de` answers the
    # same payload and is NOT used for the build (we take the venue's own host,
    # and record the mirror in the ordering URLs for reference).
    "storefront_origin": "https://www.threebuddies.de",
    "storefront_mirror": "https://storefront.foodamigos.io/api/stores/threebuddies.de",
    "backend_api": "https://app.foodamigos.io/api",
    "ordering_url": "https://www.threebuddies.de/speisekarte/threebuddies",
    "user_agent": (
        "cvm-services-venue-adapter/1.0 "
        "(+https://github.com/cvm-services/contextvm-services)"
    ),
}

# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #
# JSON paths blanked in the committed evidence copies. The venue facts we publish
# are the restaurant's own public data (address, hours, menu, prices, and the
# business phone an order needs). Owner identity, owner email/phone, platform
# payment keys and Google review author records are not ours to republish.
STORE_REDACTIONS = [
    "data.impressums[*].owner",
    "data.impressums[*].email",
    "data.impressums[*].phone_number",
    "data.impressums[*].tax_id",
    "data.business_owners",
    "data.google_cloud.api_key",
    "data.service_provider.mixpanel_api_key",
    "data.service_provider.notification_channels",
    # third-party review authors: names + profile photo URLs
    "data.companies[*].google_reviews",
]
COMPANY_REDACTIONS = [
    "company.email",
    "company.stripe_id",
    "company.business_profile.owner_email",
    "company.business_profile.owner_phone_number",
    "company.business_profile.owner_first_name",
    "company.business_profile.owner_last_name",
    "company.impressum.owner_email",
    "company.impressum.owner_phone_number",
    "company.impressum.owner_first_name",
    "company.impressum.owner_last_name",
    "company.service_provider.stripe_key",
    "company.service_provider.adyen_key",
    "company.service_provider.mixpanel_api_key",
    "company.service_provider.amplitude_api_key",
    "company.service_provider.platform_mixpanel_token",
    "company.service_provider.google_analytics_id",
    "company.service_provider.sender_email",
    "company.service_provider.support_email",
    "company.service_provider.otp_delivery_channels",
]

# Values that ARE published on purpose, so the leak guard must not flag them.
# The venue's own business phone is restaurant contact data (the same number its
# storefront shows) and venue.json carries it so a customer can call the order in.
ALLOWED_PUBLISHED = [
    "+49 30 48625381",  # the venue's public business phone (store payload)
]

WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

# Verbatim byte-slices of the committed evidence files, kept as human-readable
# evidence in the PR. (anchor, length, filename). Anchors match the canonical
# (indent=2, sort_keys) serialisation written by write_json().
FRAGMENT_SPECS = {
    "store": [
        (b'"franchise_slug"', 600, "store.venue.fragment.txt"),
        (b'"quarter"', 500, "store.quarter.fragment.txt"),
    ],
    "company": [
        (b'"legal_address"', 500, "company.location.fragment.txt"),
        (b'"work_schedule"', 500, "company.work-schedule.fragment.txt"),
        (b'"delivery_zones"', 400, "company.delivery-zones.fragment.txt"),
        (b'"payment_gateways"', 300, "company.payment-gateways.fragment.txt"),
    ],
    "menus": [
        (b'"base_price"', 500, "menus.product.fragment.txt"),
        (b'"category_ids"', 400, "menus.category-ids.fragment.txt"),
    ],
}

# Byte patterns that must never appear in a committed fragment. The slices are
# taken from the already-redacted copies, so a hit here is a real defect.
PII_GUARD = [b"@", b"owner_", b"stripe_key", b"adyen_key", b"notification_channels",
             b"author_name", b"profile_photo_url", b"AIza"]

# Patterns that must never appear in a committed evidence copy. "@" catches
# emails (the venue's only published contact is a phone; its email is redacted),
# the rest are credential shapes the platform returns.
EVIDENCE_LEAK_PATTERNS = [b"@", b"AIza", b"pk_live_", b"sk_live_", b"acct_",
                          b"live_2R", b"author_name", b"profile_photo_url"]

# The platform embeds contact data inside PROSE too: the venue's own
# `about_us_section` franchise pitch ends by asking the reader to email an address
# at the venue's domain, and the storefront's contact block renders the platform's
# masked company phone. Neither is named after a field, so no path list can reach
# them.
# Path-based redaction cannot reach that, so every committed copy also gets a
# free-text scrub. Emails always go. Phone-like runs go unless the whole match is
# a deliberately published number — a bare digit run with no "+"/separator is left
# alone so numeric ids survive.
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# The lookarounds matter: without them the digit run inside a UUID
# ("acc8c0b0-484b-<digits>b7c2f62b") looks phone-shaped and gets destroyed —
# which the "[REDACTED" invariant in run() then caught. A phone-like run must
# stand alone between non-token characters.
# The separator class holds only SPACES, never \n. A newline-joining class welded
# a street number to a postcode ("131\n\n12167") into a false phone, and the
# decimal bound (.,) keeps latitude/longitude digit runs out of it (53.72541...).
PHONE_RE = re.compile(
    r"(?<![0-9A-Za-z.,\-])\+?\d[0-9 \t\u00a0\-/()]{7,}\d(?![0-9A-Za-z.,\-])"
)


def _scrub_phones(text: str) -> str:
    def repl(m: re.Match) -> str:
        raw = m.group(0)
        if raw.strip() in ALLOWED_PUBLISHED:
            return raw
        digits = re.sub(r"\D", "", raw)
        if len(digits) < 9:
            return raw
        if not (raw.lstrip().startswith("+") or re.search(r"[\s\-/()]", raw)):
            return raw  # bare digit runs are ids, not phone numbers
        return "[REDACTED-PHONE]"

    return PHONE_RE.sub(repl, text)


def scrub_free_text(text: str) -> str:
    return _scrub_phones(EMAIL_RE.sub("[REDACTED-EMAIL]", text))


def _scrub_regression() -> None:
    """The scrubber must not eat identifiers, and must still eat contact data."""
    uuid = "acc8c0b0-484b-1234567890b7c2f62b"
    assert scrub_free_text(uuid) == uuid, f"scrubber mangled an id: {scrub_free_text(uuid)!r}"
    assert scrub_free_text('"id": "2022-06-14"') == '"id": "2022-06-14"', "date mangled"
    assert "[REDACTED-PHONE]" in scrub_free_text('"phone": "+49 30 00000000"'), \
        "a non-published phone number must be scrubbed"
    assert "+49 30 48625381" in scrub_free_text('"phone_number": "+49 30 48625381"'), \
        "the venue's published number must survive the scrub"
    prose = "sende uns eine E-Mail an kontakt@example-venue.invalid bitte"
    assert "kontakt@example-venue.invalid" not in scrub_free_text(prose)
    assert scrub_free_text(prose) == "sende uns eine E-Mail an [REDACTED-EMAIL] bitte"
    print("SCRUB REGRESSION OK ids/numbers survive; phones and emails are removed")


def collect_redacted_values(obj, paths: list[str]):
    """All raw values a redaction list targets, so the leak guard can prove their
    absence from the committed copy (a redaction regression becomes a build
    failure instead of a leak)."""
    found = []

    def walk(node, parts):
        if not parts:
            return
        head, rest = parts[0], parts[1:]
        if head == "[*]":
            if isinstance(node, list):
                for item in node:
                    walk(item, rest) if rest else found.append(json.dumps(item, ensure_ascii=False))
            return
        if isinstance(node, dict) and head in node:
            walk(node[head], rest) if rest else found.append(node[head])

    for path in paths:
        parts = []
        for seg in path.split("."):
            if seg.endswith("[*]"):
                parts += [seg[:-3], "[*]"]
            else:
                parts.append(seg)
        walk(obj, parts)
    return [v for v in found if isinstance(v, str) and len(v) >= 4]


def assert_no_leak(name: str, before, after_blob: bytes, paths: list[str]) -> None:
    """Fail the build if a value the redaction list targets survived into the
    committed copy (unless it is a deliberately published venue fact)."""
    for value in collect_redacted_values(before, paths):
        if value in ALLOWED_PUBLISHED or value == "[REDACTED]":
            continue
        if value.encode("utf-8") in after_blob:
            raise RuntimeError(
                f"{name}: redaction failed — the value of a listed path "
                f"({value!r}) is still present in the committed copy"
            )
    for pat in EVIDENCE_LEAK_PATTERNS:
        if pat in after_blob:
            raise RuntimeError(
                f"{name}: committed copy contains {pat!r}; add the field to the "
                f"redaction list (or, if it is a deliberate publication, to "
                f"ALLOWED_PUBLISHED) — do not ship it silently"
            )


# --------------------------------------------------------------------------- #
# fetch / io
# --------------------------------------------------------------------------- #
def http_get_json(url: str, timeout: int = 45) -> tuple[bytes, object]:
    req = urllib.request.Request(url, headers={
        "User-Agent": CONFIG["user_agent"],
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        status = resp.status
    if status != 200:
        raise RuntimeError(f"HTTP {status} for {url}")
    return raw, json.loads(raw.decode("utf-8"))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def redact(obj, paths: list[str]):
    for path in paths:
        parts = []
        for seg in path.split("."):
            if seg.endswith("[*]"):
                parts.append(seg[:-3])
                parts.append("[*]")
            else:
                parts.append(seg)
        _redact_walk(obj, parts)
    return obj


def _redact_walk(node, parts):
    if not parts:
        return
    head, rest = parts[0], parts[1:]
    if head == "[*]":
        if isinstance(node, list):
            for i in range(len(node)):
                if rest:
                    _redact_walk(node[i], rest)
                else:
                    node[i] = "[REDACTED]"
        return
    if isinstance(node, dict) and head in node:
        if rest:
            _redact_walk(node[head], rest)
        else:
            node[head] = "[REDACTED]"


def write_json(path: Path, obj) -> bytes:
    """Canonical, byte-stable serialisation used for BOTH evidence and venue.json.

    One rule for everything written into this repository: it is serialised
    canonically (so a re-run against unchanged sources is byte-identical) and it
    passes through scrub_free_text() (so no email — and no phone other than the
    deliberately published venue number — can reach a committed file, whether it
    arrived in a named field or inside prose)."""
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    blob = scrub_free_text(text).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return blob


def write_fragments(kind: str, raw: bytes, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for anchor, length, fname in FRAGMENT_SPECS.get(kind, []):
        idx = raw.find(anchor)
        if idx < 0:
            continue
        frag = raw[idx:idx + length]
        for pat in PII_GUARD:
            if pat in frag:
                raise RuntimeError(
                    f"fragment {fname} would leak {pat!r}; shorten or move the anchor"
                )
        (out_dir / fname).write_bytes(frag)
        written.append(fname)
    return written


def fetch_all(raw_dir: Path) -> dict:
    """Fetch the three source calls; write redacted, canonical evidence copies."""
    store_url = f"{CONFIG['storefront_origin']}/api/store"
    raw_store, store = http_get_json(store_url)

    store_data = store.get("data", store)
    franchise_slug = store_data["franchise_slug"]
    domain = store_data["domain"]

    company_url = (
        f"{CONFIG['backend_api']}/companies/{franchise_slug}/data?hostname={domain}"
    )
    raw_company, company = http_get_json(company_url)
    company_id = company["company"]["id"]

    menus_url = f"{CONFIG['backend_api']}/companies/{company_id}/menus"
    raw_menus, menus = http_get_json(menus_url)

    # provenance hashes are taken on the bytes as fetched (pre-redaction)
    hashes = {
        "store": {"url": store_url, "file": "evidence/raw/store.json",
                  "bytes": len(raw_store), "sha256": sha256_hex(raw_store)},
        "company": {"url": company_url, "file": "evidence/raw/company.json",
                    "bytes": len(raw_company), "sha256": sha256_hex(raw_company)},
        "menus": {"url": menus_url, "file": "evidence/raw/menus.json",
                  "bytes": len(raw_menus), "sha256": sha256_hex(raw_menus)},
    }
    hashes["store"]["storefront_mirror_url"] = CONFIG["storefront_mirror"]

    pre_store, pre_company = copy.deepcopy(store), copy.deepcopy(company)
    store = redact(copy.deepcopy(store), STORE_REDACTIONS)
    company = redact(copy.deepcopy(company), COMPANY_REDACTIONS)

    store_blob = write_json(raw_dir / "store.json", store)
    company_blob = write_json(raw_dir / "company.json", company)
    menus_blob = write_json(raw_dir / "menus.json", menus)

    # Prove the redaction list did its job rather than trusting it.
    assert_no_leak("store.json", pre_store, store_blob, STORE_REDACTIONS)
    assert_no_leak("company.json", pre_company, company_blob, COMPANY_REDACTIONS)

    # fragments are slices of the committed evidence copies (post-redaction)
    write_fragments("store", store_blob, raw_dir.parent / "fragments")
    write_fragments("company", company_blob, raw_dir.parent / "fragments")
    write_fragments("menus", menus_blob, raw_dir.parent / "fragments")

    # a hash of the *committed* (redacted) copy, so a reviewer can verify the
    # file in the repo without re-fetching anything
    for key, blob in (("store", store_blob), ("company", company_blob), ("menus", menus_blob)):
        hashes[key]["committed_copy_sha256"] = sha256_hex(blob)

    write_json(raw_dir / "_provenance.json", hashes)
    return hashes


def load_raw(raw_dir: Path) -> tuple[dict, dict, dict, dict]:
    def L(name):
        return json.loads((raw_dir / name).read_text(encoding="utf-8"))

    prov_path = raw_dir / "_provenance.json"
    prov = json.loads(prov_path.read_text(encoding="utf-8")) if prov_path.exists() else {}
    return L("store.json"), L("company.json"), L("menus.json"), prov


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #
def _hhmm(t) -> str | None:
    if not t:
        return None
    return f"{int(t['hour']):02d}:{int(t['minute']):02d}"


def _schedule(rows) -> list[dict]:
    out = []
    for row in rows or []:
        op, cl = row.get("open"), row.get("close")
        if not op or not cl:
            continue
        out.append({
            "day": op.get("day"),
            "weekday": WEEKDAYS[op["day"]] if op.get("day") is not None else None,
            "opens": _hhmm(op),
            "closes": _hhmm(cl),
            "timezone": row.get("timezone") or op.get("timezone"),
        })
    return sorted(out, key=lambda r: (r["day"] if r["day"] is not None else 99))


def _number(v):
    """Coerce int/float/numeric-string to float, else None (venue API mixes both)."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# The evidence copies are redacted BEFORE this builder reads them, so a redacted
# field arrives as a placeholder. A placeholder is absence, never a value: without
# this check the record's phone became the literal string "[REDACTED-PHONE]"
# (caught by selftest + the "[REDACTED" invariant in run()).
PLACEHOLDERS = ("[REDACTED]", "[REDACTED-PHONE]", "[REDACTED-EMAIL]")


def _unmasked(v) -> str | None:
    """The platform masks some phone numbers ("+491****3394"). A masked value is
    not a usable contact, so it is treated as absent — never published as if it
    were the venue's number."""
    if not isinstance(v, str) or not v.strip():
        return None
    s = v.strip()
    if "*" in s or s in PLACEHOLDERS:
        return None
    return s


def _r1_regression() -> None:
    """Review r1 (PR#1, inherited from the doppelt adapter): numeric-string prices
    survive; an absent value stays absent."""
    item = build_item("42", {"id": 42, "name": "Käsebrot", "base_price": "7.90",
                             "is_available": True}, True)
    assert item["price"] == 7.9, f"numeric-string price dropped: {item['price']!r}"
    absent = build_item("43", {"id": 43, "name": "X", "is_available": True}, True)
    assert absent["price"] is None, f"absent price fabricated: {absent['price']!r}"
    zero = build_item("44", {"id": 44, "name": "Y", "base_price": 0}, True)
    assert zero["price"] == 0, "an explicit 0 in the source is data, not absence"
    unknown = build_item("45", {"id": 45, "name": "Z"}, True)
    assert unknown["available"] is None, "an absent flag is UNKNOWN, not False"
    grp = build_option_group(
        "g", {"id": "g", "modifier_ids": [{"id": 7, "type": "modifier"}]},
        {"7": {"name": "extra", "base_price": "1.50", "is_available": True}},
    )
    assert grp["options"][0]["price"] == 1.5, "option price string dropped"
    bym = build_item("46", {"id": 46, "name": "W", "base_price": 1.0,
                            "order_method_prices": {"delivery": "9.90",
                                                    "pickup": None}}, True)
    assert bym["prices_by_order_method"] == {"delivery": 9.9}, bym["prices_by_order_method"]
    # a masked phone is absent, never published as the venue's number
    assert _unmasked("+491****3394") is None, "masked phone published as a contact"
    assert _unmasked("+49 30 48625381") == "+49 30 48625381", "real phone dropped"
    print("R1 REVIEW REGRESSION OK")


def build_item(pid: str, p: dict, listed: bool) -> dict:
    nut = p.get("nutrition_info") or {}
    item = {
        "sku": str(p.get("id", pid)),
        "name": p.get("name"),
        "description": p.get("description") or None,
        "price": _number(p.get("base_price")),
        "currency": None,  # filled by caller
        # the venue API mixes 7.9 and "7.90": numeric strings are prices
        # too, and an unparseable value is DROPPED, never published as 0.
        "prices_by_order_method": {
            k: n for k, v in (p.get("order_method_prices") or {}).items()
            if (n := _number(v)) is not None
        },
        "available": None if p.get("is_available") is None else bool(p.get("is_available")),
        "listed_in_menu": listed,
        "section_ids": [str(c) for c in (p.get("category_ids") or [])],
        "option_group_ids": [str(g) for g in (p.get("modifier_group_ids") or [])],
        "image_url": p.get("image_url") or None,
        "source": "venue-api",
    }
    if nut.get("allergens_list"):
        item["allergens"] = list(nut["allergens_list"])
    if nut.get("additives_list"):
        item["additives"] = list(nut["additives_list"])
    if nut.get("ingredients_text"):
        item["ingredients"] = nut["ingredients_text"]
    return item


def build_option_group(gid: str, g: dict, modifiers: dict) -> dict:
    opts = []
    for ref in g.get("modifier_ids") or []:
        ref_id = str(ref.get("id"))
        if ref.get("type") == "modifier":
            m = modifiers.get(ref_id)
            if not m:
                continue
            opts.append({
                "id": ref_id,
                "name": m.get("name"),
                "price": _number(m.get("base_price")),
                "available": None if m.get("is_available") is None else bool(m.get("is_available")),
            })
        else:  # cross-sell reference to another product
            opts.append({"id": ref_id, "type": "product_ref"})
    return {
        "id": str(g.get("id", gid)),
        "name": g.get("name"),
        "required": bool(g.get("is_required")),
        "max_count": g.get("max_count"),
        "multi_select": bool(g.get("multiply")),
        "options": opts,
    }


def build_venue(store, company, menus, raw_dir: Path) -> dict:
    sdata = store.get("data", store)
    cdata = company["company"]
    fdata = company.get("franchise", {})
    mdata = menus.get("data", menus)

    store_company_rec = (sdata.get("companies") or [{}])[0]
    location = (cdata.get("locations") or [{}])[0]
    currency = cdata.get("currency") or sdata.get("currency")

    ordering_urls = {
        "venue_site": CONFIG["ordering_url"],
        "storefront_preview": f"https://{sdata.get('preview_domain')}" if sdata.get("preview_domain") else None,
        "platform_shop": cdata.get("web_shop_url") or fdata.get("web_shop_url"),
        "external_web_shop": sdata.get("external_web_shop_url"),
    }
    ordering_urls = {k: v for k, v in ordering_urls.items() if v}

    # The platform masks the company-level phone; the store payload carries the
    # venue's public business number. Publish the usable one, and only if it is
    # not masked.
    phone = _unmasked(cdata.get("phone_number")) or _unmasked(sdata.get("phone_number"))
    gateway = cdata.get("payment_gateway")
    gateways = list(cdata.get("payment_gateways") or ([gateway] if gateway else []))
    pay_methods = list(cdata.get("supported_payment_methods") or [])

    delivery = {
        "available": bool(cdata.get("has_delivery")),
        "enabled": bool(cdata.get("delivery_enabled")),
        "mode": cdata.get("delivery_mode"),
        "estimated_minutes": (cdata.get("average_order_delivery_time") or {}).get("min"),
        "schedule": _schedule(cdata.get("delivery_schedule")),
        "zones": [{
            "id": z.get("id"),
            "name": z.get("name"),
            "geometry_type": z.get("geometry_type"),
            "center": (z.get("geometry_data") or {}).get("center"),
            "radius_m": (z.get("geometry_data") or {}).get("radius"),
            "min_order": z.get("min_threshold"),
            "max_order": z.get("max_threshold"),
            "fee": z.get("fee"),
            "currency": currency,
        } for z in (cdata.get("delivery_zones") or [])],
        "areas_named": list(sdata.get("delivery_areas") or []),
    }

    # The platform publishes the cuisine list on the company; the store payload
    # only has a single "restaurant_type" ("Burger") which is a subset of it.
    cuisine_src = list(cdata.get("cuisine_types") or []) or [
        sdata.get("restaurant_type") or sdata.get("food_type")]
    cuisine = []
    for c in cuisine_src:
        if c and c.lower() not in cuisine:
            cuisine.append(c.lower())

    venue_block = {
        "provider": "foodamigos",
        "store_id": sdata.get("id"),
        "store_uuid": sdata.get("uuid"),
        "company_id": cdata.get("id"),
        "company_slug": cdata.get("slug"),
        "franchise_id": fdata.get("id"),
        "franchise_slug": fdata.get("slug") or sdata.get("franchise_slug"),
        # The storefront payload binds store 481 to company 509, the resolved
        # company payload is 550, and both answer /menus. Recorded, not hidden:
        # the committed browser capture shows the venue's own page loading 550.
        "company_binding": {
            "storefront_payload_company_id": store_company_rec.get("id"),
            "resolved_company_id": cdata.get("id"),
            "menus_source_company_id": cdata.get("id"),
            "agrees": store_company_rec.get("id") == cdata.get("id"),
            "note": (
                "The storefront payload's companies[0].id and the company payload's id "
                "differ, and BOTH answer /menus with HTTP 200. The venue's own ordering "
                "page requests /companies/"
                f"{cdata.get('id')}/menus (evidence/requests.json); the rendered page's "
                "prices match that payload (adapter.py --verify-rendered). This record "
                f"follows the venue's own page and uses company {cdata.get('id')}."
            ),
        },
        "name": cdata.get("name") or sdata.get("name"),
        "display_name": sdata.get("name"),
        "type": sdata.get("venue_type") or "restaurant",
        "cuisine": cuisine,
        "dietary_attributes": list(sdata.get("dietary_attributes") or []),
        "about": (sdata.get("about_us_section", {}).get("content") or {}).get("description"),
        "phone": phone,
        "website": f"https://{cdata.get('website_link')}" if cdata.get("website_link") else None,
        "address": {
            "street": cdata.get("address") or sdata.get("address"),
            "postal_code": cdata.get("zip_code") or sdata.get("zip_code"),
            "city": cdata.get("city") or sdata.get("city"),
            "quarter": sdata.get("quarter"),
            "state": cdata.get("state"),
            "country": cdata.get("country") or sdata.get("country"),
            "lat": _number(cdata.get("lat")) if cdata.get("lat") is not None else _number(location.get("lat")),
            "lon": _number(cdata.get("lon")) if cdata.get("lon") is not None else _number(location.get("lon")),
        },
        "timezone": cdata.get("timezone") or sdata.get("timezone"),
        "currency": currency,
        "locales": list((cdata.get("region") or {}).get("locales") or []),
        "order_methods": [m for m, on in (
            ("pickup", cdata.get("has_pickup")),
            ("delivery", cdata.get("has_delivery")),
        ) if on],
        "opening_hours": _schedule(cdata.get("work_schedule")),
        "pickup": {
            "available": bool(cdata.get("has_pickup")),
            "estimated_minutes": (cdata.get("average_order_preparation_time") or {}).get("min"),
        },
        "delivery": delivery,
        "reservation_url": sdata.get("reservation_link"),
        "ordering": {
            "primary_url": CONFIG["ordering_url"],
            "urls": ordering_urls,
            "note": ("The venue's own ordering page; loaded client-side, its menu request "
                     "is the one recorded in evidence/requests.json."),
        },
        "settlement": {
            "rail": (
                "venue's own rail (FoodAmigos storefront: "
                + ", ".join(gateways or ["unknown"])
                + (f"; accepts {', '.join(pay_methods)}" if pay_methods else "")
                + ")"
            ),
            "currency": currency,
            "tax": f"{cdata.get('tax_behaviour')} {cdata.get('tax_percentage')}%",
            "cvm_cap": None,
        },
        "ratings": {
            "google": {
                "rating": _number(cdata.get("google_rating")),
                "reviews": cdata.get("google_rates_count"),
            },
        },
        # ADR-0007 asks every adapter to state the class it is and the
        # capabilities it can actually exercise. This one is class 1
        # (deep link + human): the CVM returns a basket for the venue's own rail
        # and a human completes checkout/payment. It does NOT place or settle an
        # order, so submit/status are false — claiming them would be the silent
        # degrade ADR-0007 forbids.
        "adapter": {
            "class": "deep_link_human",
            "class_per_adr": "docs/adr/0007-venue-adapter-interface.md — class 1",
            "capabilities": {
                "menu": True,
                "quote": True,
                "submit": False,
                "status": False,
            },
            "human_steps": [
                "choose pickup or delivery (and, for delivery, an address)",
                "open the venue's own ordering page at ordering.primary_url",
                "pay the venue on the venue's own rail (card/paypal/cash; 3DS as the venue requires)",
                "a human confirms the order with the venue",
            ],
            "credential_owner": None,
            "credential_scope": None,
            "payment_authority": "the venue's own rail; this CVM takes no payment (ADR-0001 D5)",
            "idempotency_key": None,
            "order_receipt": "the venue's own confirmation (not machine-readable here)",
            "why_this_class": (
                "The platform DOES run an online shop for this venue, but no unauthenticated or "
                "test-mode path to place an order was found or verified: the storefront's cart and "
                "checkout are authenticated, session-bound browser flows (the capture shows Stripe/"
                "Google Pay material loaded, and clicking 'Lieferung' opens an address modal). Per "
                "ADR-0007 the honest capability set is menu+quote only, with submit/status false."
            ),
            "browser_automation_used": False,
        },
    }

    # ---- menu ---------------------------------------------------------------
    cats = mdata.get("categories") or {}
    prods = mdata.get("products") or {}
    mods = mdata.get("modifiers") or {}
    mgroups = mdata.get("modifier_groups") or {}

    def cat_sort_key(c):
        so = c.get("sorting_order")
        return (0 if so is None else 1, so if so is not None else 0, int(c["id"]))

    sections = []
    listed_ids = []
    for c in sorted(cats.values(), key=cat_sort_key):
        item_ids = [str(i) for i in (c.get("product_ids") or []) if str(i) in prods]
        listed_ids.extend(i for i in item_ids if i not in listed_ids)
        sections.append({
            "id": str(c["id"]),
            "name": c.get("name"),
            "kind": c.get("type"),
            "sorting_order": c.get("sorting_order"),
            "menu_ids": [str(m) for m in (c.get("menu_ids") or [])],
            "item_skus": item_ids,
        })

    items = []
    for pid in listed_ids:
        it = build_item(pid, prods[pid], listed=True)
        it["currency"] = currency
        items.append(it)

    unlisted = []
    for pid, p in prods.items():
        if str(pid) in listed_ids:
            continue
        it = build_item(pid, p, listed=False)
        it["currency"] = currency
        unlisted.append(it)
    unlisted.sort(key=lambda i: int(i["sku"]))

    priced = [i["price"] for i in items if i["price"] is not None]
    prices_all = [i["price"] for i in items + unlisted if i["price"] is not None]

    menu_block = {
        "currency": currency,
        "menus": [{
            "id": str(m.get("id")),
            "name": m.get("name"),
            "active": bool(m.get("is_active")),
            "category_ids": [str(c) for c in (m.get("category_ids") or [])],
            "schedule": _schedule(m.get("schedule")),
        } for m in (mdata.get("menus") or [])],
        "sections": sections,
        "items": items,
        # products the API returns for this company that are attached to no
        # rendered section (their categories are not in the menus payload and do
        # not appear on the ordering page). Kept for completeness, not priced-in.
        "unlisted_items": unlisted,
        "option_groups": [
            build_option_group(gid, g, mods)
            for gid, g in sorted(mgroups.items(), key=lambda kv: int(kv[0]))
        ],
        "stats": {
            "sections": len(sections),
            "menus": len(mdata.get("menus") or []),
            "items_listed": len(items),
            "items_unlisted": len(unlisted),
            "items_priced_listed": len(priced),
            "min_price_listed": min(priced) if priced else None,
            "max_price_listed": max(priced) if priced else None,
            "min_price_all": min(prices_all) if prices_all else None,
        },
    }

    raw_block = {}
    prov_path = Path(raw_dir) / "_provenance.json"
    if prov_path.exists():
        raw_block = json.loads(prov_path.read_text(encoding="utf-8"))
        for entry in raw_block.values():
            entry["committed_copy_redacted"] = True

    return {
        "schema": "cvm.venue/v1",
        "slug": CONFIG["slug"],
        "generated_by": "venues/three-buddies-berlin/adapter.py",
        "venue": venue_block,
        "menu": menu_block,
        "source": {
            "attribution": (
                "Venue facts, menu and prices (c) Three Buddies, Albrechtstraße 131, "
                "12167 Berlin (Steglitz) — retrieved from the venue's own public JSON API "
                "(FoodAmigos storefront). Product images are referenced by URL only "
                "and are not copied into this repository."
            ),
            "calls": raw_block,
            "parser": "plain HTTPS GET + JSON parse; no OCR, no scraping of HTML",
        },
    }


# --------------------------------------------------------------------------- #
# the rendered-page anchor (independent of venue.json)
# --------------------------------------------------------------------------- #
# The storefront prints one price column at a time (Abholung by default) as
#   <item name>
#   <blank>
#   <price> €
# with an optional "(150 g)" line after the price. Section headers are followed by
# a name, never by a price, so "the nearest preceding non-blank line" is the item.
# NB the storefront separates the number from the sign with a NON-BREAKING space
# (U+00A0), so a plain " " in the pattern would find nothing at all.
PAGE_PRICE_RE = re.compile(r"^(\d{1,3},\d{2})[ \u00a0]*€$")


def parse_rendered_prices(path: Path) -> dict[str, float]:
    """name -> price, read from the text a real browser rendered. First wins."""
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()]
    out: dict[str, float] = {}
    for i, line in enumerate(lines):
        m = PAGE_PRICE_RE.match(line)
        if not m:
            continue
        name = None
        for j in range(i - 1, -1, -1):
            if lines[j]:
                name = lines[j]
                break
        if not name or name.startswith("🏅") or name.startswith("#"):
            continue
        out.setdefault(name, float(m.group(1).replace(",", ".")))
    return out


def write_price_anchor(venue: dict, page_path: Path, out_path: Path) -> dict:
    """Write the committed expectation file. The values come from the PAGE, not
    from venue.json, so the file is an anchor and not a copy of the thing it
    checks. Each entry keeps the verbatim page line it was read from."""
    page = parse_rendered_prices(page_path)
    try:
        page_ref = str(page_path.relative_to(HERE))
    except ValueError:
        page_ref = str(page_path)
    entries = []
    for name, price in sorted(page.items()):
        entries.append({
            "name": name,
            "method": "pickup",
            "price_eur": price,
            "page_source": page_ref,
        })
    anchor = {
        "schema": "cvm.venue.page-price-anchor/v1",
        "note": (
            "Prices read from the text the venue's OWN ordering page rendered "
            "(Abholung/pickup column). Used to check venue.json against something that "
            "was NOT derived from venue.json. Regenerate: adapter.py --write-anchor"
        ),
        "page_dump": "evidence/rendered-ordering-page.txt",
        "method": "pickup",
        "entry_count": len(entries),
        "entries": entries,
    }
    write_json(out_path, anchor)
    return anchor


def check_anchor(venue: dict, anchor: dict, verbose: bool = True) -> tuple[int, list[str]]:
    """Compare venue.json prices against the page-derived anchor.

    Returns (exit_code, mismatches). An entry is a mismatch if the record has no
    such item, or its pickup price differs from the page's. A check that matches
    fewer than 10 items is treated as a failure: a vacuous pass is worse than a
    loud one.
    """
    items = venue["menu"]["items"]
    by_name = {}
    for it in items:
        by_name.setdefault(it["name"], it)

    mismatches: list[str] = []
    matched = 0
    for e in anchor["entries"]:
        it = by_name.get(e["name"])
        if it is None:
            mismatches.append(f"'{e['name']}': on the venue's page at {e['price_eur']:.2f} "
                              f"EUR but absent from venue.json")
            continue
        record_price = it["prices_by_order_method"].get(e["method"], it["price"])
        if record_price is None or abs(record_price - e["price_eur"]) > 1e-9:
            mismatches.append(f"'{e['name']}': venue.json={record_price} "
                              f"page={e['price_eur']:.2f}")
            continue
        matched += 1

    if verbose:
        print(f"ANCHOR CHECK entries={len(anchor['entries'])} matched={matched} "
              f"mismatches={len(mismatches)}")
        for line in mismatches[:20]:
            print("  MISMATCH", line)
    if matched < 10:
        mismatches.append(f"only {matched} anchor entries matched — check is vacuous")
        if verbose:
            print(f"  VACUOUS: matched {matched} < 10 required")
    return (1 if mismatches else 0), mismatches


def verify_rendered(venue: dict, path: Path) -> int:
    """Parse the page dump directly and compare with venue.json (no anchor file)."""
    page = parse_rendered_prices(path)
    items = venue["menu"]["items"]
    by_name = {}
    for it in items:
        by_name.setdefault(it["name"], it)

    matched, mismatches, missing = 0, [], []
    for name, page_price in page.items():
        it = by_name.get(name)
        if not it:
            missing.append(name)
            continue
        rec = it["prices_by_order_method"].get("pickup", it["price"])
        if rec is None or abs(rec - page_price) > 1e-9:
            mismatches.append(f"{name}: venue.json={rec} page={page_price:.2f}")
        else:
            matched += 1

    print(f"RENDERED CROSS-CHECK items_on_page={len(page)} matched={matched} "
          f"not_in_venue_json={len(missing)} mismatches={len(mismatches)}")
    for name in missing[:20]:
        print("  not-matched (page text the item-name heuristic also caught):", repr(name))
    for line in mismatches:
        print("  MISMATCH", line)
    return 1 if (mismatches or matched < 10) else 0


def negative_test(venue: dict, anchor: dict) -> int:
    """Prove the anchor check is live: perturb one price and require a FAILURE.

    A check that cannot fail proves nothing. This runs the same `check_anchor`
    against a copy of the record with one anchored price moved by +1.00 EUR, and
    exits 0 only if the check reports exactly that item (and, if the perturbed
    item was the sole priced match, the vacuity guard fires).
    """
    perturbed = copy.deepcopy(venue)
    target = anchor["entries"][0]["name"]
    wanted = anchor["entries"][0]["price_eur"] + 1.0
    hit = None
    for it in perturbed["menu"]["items"]:
        if it["name"] == target:
            it["price"] = wanted
            it["prices_by_order_method"]["pickup"] = wanted
            hit = it
            break
    if hit is None:
        print(f"NEGATIVE TEST FAIL: anchor item '{target}' is not in venue.json")
        return 1

    print(f"NEGATIVE TEST: perturbed '{target}' to {wanted:.2f} EUR in an in-memory "
          f"copy (the committed record is untouched)")
    rc, mismatches = check_anchor(perturbed, anchor, verbose=False)
    print(f"  check_anchor on the perturbed copy -> exit {rc}")
    for line in mismatches:
        print("  PERTURBED-FAILURE:", line)
    ok = rc != 0 and any(target in m for m in mismatches)
    print("NEGATIVE TEST OK — the check fails when a price is perturbed "
          "(a vacuous check would have passed)" if ok
          else "NEGATIVE TEST FAIL — the check passed a perturbed price; it proves nothing")
    return 0 if ok else 1


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def summary_line(venue: dict, digest: str) -> str:
    st = venue["menu"]["stats"]
    return (
        f"PARSE OK menus={st['menus']} sections={st['sections']} "
        f"items_listed={st['items_listed']} items_unlisted={st['items_unlisted']} "
        f"priced_listed={st['items_priced_listed']} "
        f"min_price={st['min_price_listed']:.2f} max_price={st['max_price_listed']:.2f} "
        f"currency={venue['menu']['currency']} sha256={digest}"
    )


def run(args) -> int:
    raw_dir = Path(args.raw_dir)
    venue_path = Path(args.venue)

    if args.fetch or not (raw_dir / "menus.json").exists():
        print(f"fetching {CONFIG['storefront_origin']} ...", file=sys.stderr)
        fetch_all(raw_dir)

    store, company, menus, _prov = load_raw(raw_dir)
    venue = build_venue(store, company, menus, raw_dir)
    blob = (scrub_free_text(json.dumps(venue, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
            ).encode("utf-8")
    assert_no_leak("venue.json", venue, blob, [])
    # A redaction that ran before the builder did must never surface in the record:
    # a placeholder in venue.json would be published as if it were venue data.
    assert b"[REDACTED" not in blob, "a redaction placeholder leaked into venue.json"
    digest = sha256_hex(blob)

    if args.selftest:
        _r1_regression()
        _scrub_regression()
        blob2 = (scrub_free_text(json.dumps(
            build_venue(*[json.loads(json.dumps(x)) for x in (store, company, menus)], raw_dir),
            ensure_ascii=False, indent=2, sort_keys=True) + "\n")).encode("utf-8")
        assert blob == blob2, "non-deterministic build"
        st = venue["menu"]["stats"]
        assert st["items_priced_listed"] >= 50, f"only {st['items_priced_listed']} priced items"
        assert st["sections"] >= 5, "too few sections"
        skus = {i["sku"] for i in venue["menu"]["items"]}
        assert len(skus) == len(venue["menu"]["items"]), "duplicate sku in items"
        for i in venue["menu"]["items"]:
            assert i["price"] is None or i["price"] > 0, f"bad price for {i['sku']}"
        assert venue["venue"]["company_id"] == 550, "menus company id drifted"
        assert venue["venue"]["company_binding"]["storefront_payload_company_id"] == 509, \
            "the storefront company binding changed — re-check which menu the venue serves"
        assert venue["venue"]["adapter"]["capabilities"]["submit"] is False, \
            "submit must not be claimed"
        assert venue["venue"]["phone"] == "+49 30 48625381", \
            f"venue phone is not the venue's published number: {venue['venue']['phone']!r}"
        assert venue["venue"]["name"] == "Three Buddies Steglitz", "venue name drifted"
        print("SELFTEST OK deterministic=1 duplicate_skus=0 "
              f"priced=+{st['items_priced_listed']} sections={st['sections']}")

    if args.write_anchor:
        anchor = write_price_anchor(venue, Path(args.rendered), Path(args.write_anchor))
        print(f"ANCHOR WRITTEN {args.write_anchor} entries={anchor['entry_count']}")

    if args.anchor:
        anchor = json.loads(Path(args.anchor).read_text(encoding="utf-8"))
        rc, _ = check_anchor(venue, anchor)
        if rc != 0:
            return rc

    if args.negative_test:
        anchor_path = Path(args.anchor or HERE / "evidence/anchor/page-price-anchor.json")
        anchor = json.loads(anchor_path.read_text(encoding="utf-8"))
        rc = negative_test(venue, anchor)
        if rc != 0:
            return rc

    if args.verify_rendered:
        rc = verify_rendered(venue, Path(args.verify_rendered))
        if rc != 0:
            return rc

    if args.check:
        if not venue_path.exists():
            print(f"CHECK FAIL: {venue_path} missing", file=sys.stderr)
            return 1
        on_disk = venue_path.read_bytes()
        disk_digest = sha256_hex(on_disk)
        if on_disk != blob:
            print(f"CHECK FAIL on-disk={disk_digest} rebuilt={digest}", file=sys.stderr)
            return 1
        print(summary_line(venue, digest) + " MATCH")
        return 0

    venue_path.parent.mkdir(parents=True, exist_ok=True)
    venue_path.write_bytes(blob)
    print(summary_line(venue, digest))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw-dir", default=str(HERE / "evidence" / "raw"))
    ap.add_argument("--venue", default=str(HERE / "venue.json"))
    ap.add_argument("--rendered", default=str(HERE / "evidence" / "rendered-ordering-page.txt"))
    ap.add_argument("--fetch", action="store_true", help="force re-fetch from the source")
    ap.add_argument("--check", action="store_true", help="rebuild and compare with venue.json")
    ap.add_argument("--selftest", action="store_true", help="determinism + invariant assertions")
    ap.add_argument("--write-anchor", metavar="FILE",
                    help="write the page-derived price anchor (expectation file)")
    ap.add_argument("--anchor", metavar="FILE",
                    help="check venue.json against a committed page-derived anchor")
    ap.add_argument("--negative-test", action="store_true",
                    help="perturb a price and require the anchor check to fail")
    ap.add_argument("--verify-rendered", metavar="FILE",
                    help="cross-check prices by parsing the rendered page dump directly")
    return run(ap.parse_args())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (urllib.error.URLError, RuntimeError) as exc:  # network / build failure
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
