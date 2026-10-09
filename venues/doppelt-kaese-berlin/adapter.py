#!/usr/bin/env python3
"""doppelt-kaese-berlin.de -> venue.json  (CVM venue adapter, S1a)

WHAT THIS DOES
--------------
The venue site (https://www.doppelt-kaese-berlin.de) is a FoodAmigos "storefront"
app: the served HTML contains no prices, and the menu is fetched client-side.
A headed browser on the menu route shows exactly three JSON calls that carry the
venue record (verified 2026-10-05, see evidence/):

  1. GET https://www.doppelt-kaese-berlin.de/api/store
       -> storefront payload (name, address, franchise_slug, region, delivery_areas)
  2. GET https://app.foodamigos.io/api/companies/<franchise_slug>/data?hostname=<domain>
       -> company payload (id, lat/lon, address, work_schedule, delivery_zones)
  3. GET https://app.foodamigos.io/api/companies/<company_id>/menus
       -> menus, categories, products (base_price + per-order-method prices),
          modifier groups, allergens/additives

All three answer plain unauthenticated GETs, so this adapter re-fetches them with
urllib (no browser, no OCR) and normalises them into ONE canonical venue record.

Every price in venue.json comes from `base_price` / `order_method_prices` of the
product objects returned by call 3. Nothing is inferred, nothing is OCR'd.

USAGE
-----
  python3 adapter.py                # fetch (if needed), write evidence + venue.json
  python3 adapter.py --fetch        # force re-fetch from the network
  python3 adapter.py --check        # rebuild from committed evidence, verify hash
  python3 adapter.py --selftest     # determinism + invariant assertions
  python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
                                     # cross-check prices against the page a real
                                     # browser rendered (independent of the API)

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
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

CONFIG = {
    "slug": "doppelt-kaese-berlin",
    "domain": "doppelt-kaese-berlin.de",
    "storefront_origin": "https://www.doppelt-kaese-berlin.de",
    "backend_api": "https://app.foodamigos.io/api",
    "ordering_url": "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase",
    "user_agent": (
        "cvm-services-venue-adapter/1.0 "
        "(+https://github.com/cvm-services/contextvm-services)"
    ),
}

# JSON paths blanked in the committed evidence copies. The venue facts we publish
# are public restaurant data; owner emails/phones, payment-platform keys and
# Google review author names are not ours to republish. Values are replaced with
# the string "[REDACTED]" and each path is listed in evidence/PROVENANCE.md.
STORE_REDACTIONS = [
    "data.impressums[*].owner",
    "data.impressums[*].email",
    "data.impressums[*].phone_number",
    "data.business_owners",
    "data.google_cloud.api_key",
    "data.service_provider.mixpanel_api_key",
    "data.service_provider.notification_channels",
    "data.companies[*].google_reviews",
]
COMPANY_REDACTIONS = [
    "company.email",
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

WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

# Verbatim byte-slices of the committed evidence files, kept as human-readable
# evidence in the PR. (anchor, length, filename). Anchors match the canonical
# (indent=2, sort_keys) serialisation written by write_json().
FRAGMENT_SPECS = {
    "store": [
        (b'"franchise_slug"', 600, "store.venue.fragment.txt"),
        (b'"opening_hours"', 500, "store.opening-hours.fragment.txt"),
    ],
    "company": [
        (b'"legal_address"', 500, "company.location.fragment.txt"),
        (b'"work_schedule"', 500, "company.work-schedule.fragment.txt"),
        (b'"delivery_zones"', 400, "company.delivery-zones.fragment.txt"),
    ],
    "menus": [
        (b'"base_price"', 500, "menus.product.fragment.txt"),
    ],
}

# Byte patterns that must never appear in a committed fragment. The slices are
# taken from the already-redacted copies, so a hit here is a real defect.
PII_GUARD = [b"@", b"owner_", b"stripe_key", b"adyen_key", b"notification_channels"]

# --------------------------------------------------------------------------- #
# Fulfilment facts: what the announcement may declare, and why the storefront's
# `delivery_areas` list may not (card t_7d410f66, 2026-10-09)
# --------------------------------------------------------------------------- #
# The storefront payload and the company payload are BOTH the venue's own rail,
# and they disagree about where this venue delivers:
#
#   store  data.delivery_areas  = 15 Berlin district NAMES
#                                 ("Mitte", "Kreuzberg", … "Pankow.")
#   company delivery_zones[0]   = ONE circle, radius 5000 m, centred on the
#                                 venue's own coordinates (52.4707069, 13.3202819)
#
# The name list names districts the venue's own 5000 m circle cannot reach, so it
# is not a delivery area this venue can honour. Publishing it (which the
# announcement did until this card) told a customer in Prenzlauer Berg they were
# in range of a venue that is ~10.6 km away. Two more tells that the field is not
# a per-venue computation: its last element is the literal string "Pankow." with a
# trailing period, and it contains no district adjacent-and-only.
#
# What replaces it: the venue's own geometry, verbatim, plus an explicit
# retraction record so the discarded value is auditable rather than silently gone.
RETRACTION_REASON = (
    "`data.delivery_areas` is a list of Berlin district NAMES on the venue's own "
    "storefront payload. It is not a delivery area this venue can honour: the same "
    "rail's company payload publishes the venue's delivery geometry as a single "
    "circle of 5000 m centred on the venue's own coordinates, and the named list "
    "names districts that circle cannot reach (Prenzlauer Berg, Friedrichshain, "
    "Pankow, Lichtenberg, Mitte, Kreuzberg, Wedding, Moabit, Neukölln, Tiergarten, "
    "Charlottenburg - 11 of the 15 names). Two fields served by the same rail "
    "disagree, so the name list is retracted and the announced area is the venue's "
    "own geometry. Retained here so the retraction is auditable; it is NOT a "
    "declared delivery area."
)
AREA_NOTE = (
    "Deliverable area is NOT asserted as a list of districts. The venue's own rail "
    "publishes its delivery zone as a circle: radius 5000 m centred on the venue's "
    "own coordinates, minimum order 20 EUR, delivery fee 5 EUR (company payload, "
    "delivery_zones[0]). That geometry is the declared area. The storefront's "
    "district-name list (data.delivery_areas) is retracted under "
    "delivery.areas_retracted."
)
# Fields the rail simply does not carry. Naming them is the point: an absent fact
# must read as absent, never as a plausible-looking default.
NOT_VERIFIABLE = [
    "delivery postcode coverage: this rail exposes no postcode list and no "
    "per-address deliverability endpoint (delivery.area_selector_url is null), so "
    "which postcodes are served is NOT derivable from the rail.",
    "reachability INSIDE the declared 5000 m circle: the rail publishes the "
    "geometry only; it does not publish which addresses the venue actually serves "
    "within it.",
    "the storefront's named delivery districts (data.delivery_areas): retracted, "
    "not a fact of this venue - see delivery.areas_retracted.",
]


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


def utcnow() -> str:
    """Fetch time recorded next to every field, so a reader can age the fact."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """Canonical, byte-stable serialisation used for BOTH evidence and venue.json."""
    blob = (json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
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
    t_store = utcnow()
    raw_store, store = http_get_json(store_url)

    store_data = store.get("data", store)
    franchise_slug = store_data["franchise_slug"]
    domain = store_data["domain"]

    company_url = (
        f"{CONFIG['backend_api']}/companies/{franchise_slug}/data?hostname={domain}"
    )
    t_company = utcnow()
    raw_company, company = http_get_json(company_url)
    company_id = company["company"]["id"]

    menus_url = f"{CONFIG['backend_api']}/companies/{company_id}/menus"
    t_menus = utcnow()
    raw_menus, menus = http_get_json(menus_url)

    # provenance hashes are taken on the bytes as fetched (pre-redaction)
    hashes = {
        "store": {"url": store_url, "file": "evidence/raw/store.json",
                  "bytes": len(raw_store), "sha256": sha256_hex(raw_store),
                  "fetched_at_utc": t_store},
        "company": {"url": company_url, "file": "evidence/raw/company.json",
                    "bytes": len(raw_company), "sha256": sha256_hex(raw_company),
                    "fetched_at_utc": t_company},
        "menus": {"url": menus_url, "file": "evidence/raw/menus.json",
                  "bytes": len(raw_menus), "sha256": sha256_hex(raw_menus),
                  "fetched_at_utc": t_menus},
    }

    store = redact(copy.deepcopy(store), STORE_REDACTIONS)
    company = redact(copy.deepcopy(company), COMPANY_REDACTIONS)

    store_blob = write_json(raw_dir / "store.json", store)
    company_blob = write_json(raw_dir / "company.json", company)
    menus_blob = write_json(raw_dir / "menus.json", menus)
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


def fetch_fulfilment_only(raw_dir: Path) -> dict:
    """Re-fetch ONLY the two calls that carry the venue's fulfilment facts.

    Card t_7d410f66 re-derives what the announcement declares about delivery and
    opening hours from the venue's OWN rail. The venue record is built from THREE
    calls, but the fulfilment facts all live in two of them:

      * `GET <venue>/api/store`      -> `data.delivery_areas` (the suspect field)
      * `GET app.foodamigos.io/.../companies/<slug>/data` -> `delivery_zones`,
        `work_schedule`, `delivery_schedule`, `has_pickup/has_delivery`,
        `average_order_*_time`

    The menu call is deliberately NOT re-fetched. Menu freshness is a separate
    tracked gap (G7) and re-fetching the 124 KB menu payload here would move every
    price in the diff of a card about delivery areas. The menus evidence entry
    keeps its original provenance and no `fetched_at_utc` (the S1a capture date is
    recorded in evidence/PROVENANCE.md; the exact time was not recorded then).
    """
    prov_path = raw_dir / "_provenance.json"
    existing = json.loads(prov_path.read_text(encoding="utf-8")) if prov_path.exists() else {}

    store_url = f"{CONFIG['storefront_origin']}/api/store"
    t_store = utcnow()
    raw_store, store = http_get_json(store_url)

    store_data = store["data"] if isinstance(store, dict) and "data" in store else store
    if not isinstance(store_data, dict):
        raise RuntimeError("store payload has no data object")
    domain = store_data["domain"]
    franchises = store_data["franchise_slug"]

    company_url = (
        f"{CONFIG['backend_api']}/companies/{franchises}/data?hostname={domain}"
    )
    t_company = utcnow()
    raw_company, company = http_get_json(company_url)

    store = redact(copy.deepcopy(store), STORE_REDACTIONS)
    company = redact(copy.deepcopy(company), COMPANY_REDACTIONS)
    store_blob = write_json(raw_dir / "store.json", store)
    company_blob = write_json(raw_dir / "company.json", company)
    write_fragments("store", store_blob, raw_dir.parent / "fragments")
    write_fragments("company", company_blob, raw_dir.parent / "fragments")

    hashes = dict(existing)
    hashes["store"] = {"url": store_url, "file": "evidence/raw/store.json",
                       "bytes": len(raw_store), "sha256": sha256_hex(raw_store),
                       "fetched_at_utc": t_store,
                       "committed_copy_sha256": sha256_hex(store_blob)}
    hashes["company"] = {"url": company_url, "file": "evidence/raw/company.json",
                         "bytes": len(raw_company), "sha256": sha256_hex(raw_company),
                         "fetched_at_utc": t_company,
                         "committed_copy_sha256": sha256_hex(company_blob)}
    hashes.setdefault("menus", {})
    write_json(prov_path, hashes)
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


def _r1_regression() -> None:
    """Review r1 (PR#1): numeric-string prices survive; an absent value stays absent.

    Locks the fix for `_num`, which accepted only int/float and therefore threw
    away every string-valued price the source publishes.
    """
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


def _fulfilment_provenance(calls: dict, derived_at):
    """Per-field fetch-time provenance for every fulfilment fact we declare.

    A declared fact without a source and a fetch time is a fact nobody can age
    or refute. Each entry names the source call, its URL, when it was fetched,
    and the field within that payload the value was read from.
    """
    def call(name: str, field: str, **extra) -> dict:
        c = calls.get(name) or {}
        return {
            "source_call": name,
            "url": c.get("url"),
            "fetched_at_utc": c.get("fetched_at_utc"),
            "field": field,
            **extra,
        }

    return {
        "derived_at_utc": derived_at,
        "fields": {
            "venue.order_methods": call("company", "company.has_pickup, company.has_delivery"),
            "delivery.available": call("company", "company.has_delivery"),
            "delivery.enabled": call("company", "company.delivery_enabled"),
            "delivery.mode": call("company", "company.delivery_mode"),
            "delivery.area": call("company", "company.delivery_zones[*].geometry_data"),
            "delivery.estimated_minutes": call(
                "company", "company.average_order_delivery_time.min"),
            "delivery.schedule": call("company", "company.delivery_schedule"),
            "pickup.available": call("company", "company.has_pickup"),
            "pickup.estimated_minutes": call(
                "company", "company.average_order_preparation_time.min"),
            "opening_hours": call("company", "company.work_schedule"),
            "address.lat_lon": call("company", "company.lat, company.lon"),
            "delivery.areas_named": call(
                "store", "data.delivery_areas",
                status="RETRACTED",
                reason=RETRACTION_REASON),
        },
        "not_verifiable_from_rail": NOT_VERIFIABLE,
    }


def build_venue(store, company, menus, raw_dir: Path) -> dict:
    sdata = store.get("data", store)
    cdata = company["company"]
    fdata = company.get("franchise", {})
    mdata = menus.get("data", menus)

    # Provenance for the fulfilment facts. Read here (not only at the end) so each
    # declared field can carry the URL it came from and the time it was fetched.
    prov_path = Path(raw_dir) / "_provenance.json"
    calls = json.loads(prov_path.read_text(encoding="utf-8")) if prov_path.exists() else {}
    # Deterministic: the derivation timestamp is the source call's fetch time, not
    # "now", so a rebuild from committed evidence is byte-identical (--check).
    derived_at = (calls.get("company") or {}).get("fetched_at_utc") \
        or (calls.get("store") or {}).get("fetched_at_utc")

    company_rec = (sdata.get("companies") or [{}])[0]
    location = (cdata.get("locations") or [{}])[0]
    currency = cdata.get("currency") or sdata.get("currency")

    ordering_urls = {
        "venue_site": CONFIG["ordering_url"],
        "storefront_preview": f"https://{sdata.get('preview_domain')}" if sdata.get("preview_domain") else None,
        "platform_shop": cdata.get("web_shop_url") or fdata.get("web_shop_url"),
    }
    ordering_urls = {k: v for k, v in ordering_urls.items() if v}

    zones = [{
        "id": z.get("id"),
        "name": z.get("name"),
        "geometry_type": z.get("geometry_type"),
        "center": (z.get("geometry_data") or {}).get("center"),
        "radius_m": (z.get("geometry_data") or {}).get("radius"),
        "min_order": z.get("min_threshold"),
        "max_order": z.get("max_threshold"),
        "fee": z.get("fee"),
        "currency": currency,
    } for z in (cdata.get("delivery_zones") or [])]
    circle_zones = [z for z in zones if z["geometry_type"] == "circle" and z["radius_m"]]
    storefront_areas = list(sdata.get("delivery_areas") or [])

    delivery = {
        "available": bool(cdata.get("has_delivery")),
        "enabled": bool(cdata.get("delivery_enabled")),
        "mode": cdata.get("delivery_mode"),
        # `area_mode` is what the announcement may declare as "where we deliver".
        # `radius` = the venue's own circle geometry is the area. There is no
        # postcode mode here, and no per-address endpoint is exposed.
        "area_mode": "radius" if circle_zones else None,
        "area_selector_url": None,
        "estimated_minutes": (cdata.get("average_order_delivery_time") or {}).get("min"),
        "schedule": _schedule(cdata.get("delivery_schedule")),
        "zones": zones,
        # RETRACTED (card t_7d410f66): this field WAS published as the venue's
        # delivery area and is not one. Nothing is declared here unless the rail's
        # own geometry supports it.
        "areas_named": None,
        "areas_retracted": {
            "value": storefront_areas,
            "source_call": "store",
            "field": "data.delivery_areas",
            "url": (calls.get("store") or {}).get("url"),
            "fetched_at_utc": (calls.get("store") or {}).get("fetched_at_utc"),
            "retracted_at_utc": derived_at,
            "reason": RETRACTION_REASON,
        } if storefront_areas else None,
        "area_note": AREA_NOTE,
    }

    venue_block = {
        "provider": "foodamigos",
        "store_id": sdata.get("id"),
        "store_uuid": sdata.get("uuid"),
        "company_id": cdata.get("id"),
        "company_slug": cdata.get("slug"),
        "franchise_id": fdata.get("id"),
        "franchise_slug": fdata.get("slug") or sdata.get("franchise_slug"),
        "name": cdata.get("name") or sdata.get("name"),
        "display_name": sdata.get("name"),
        "type": sdata.get("venue_type") or "restaurant",
        "cuisine": list(cdata.get("cuisine_types") or []),
        "dietary_attributes": list(sdata.get("dietary_attributes") or []),
        "about": (sdata.get("about_us_section", {}).get("content") or {}).get("description"),
        "phone": cdata.get("phone_number") or sdata.get("phone_number"),
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
                     "is the one recorded in evidence/."),
        },
        "settlement": {
            "rail": "venue's own rail (FoodAmigos storefront: Adyen/Stripe/PayPal/cash)",
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
        "generated_by": "venues/doppelt-kaese-berlin/adapter.py",
        "venue": venue_block,
        "menu": menu_block,
        "provenance": _fulfilment_provenance(calls, derived_at),
        "source": {
            "attribution": (
                "Venue facts, menu and prices (c) doppelt Käse, Laubacher Straße 11, "
                "14197 Berlin — retrieved from the venue's own public JSON API "
                "(FoodAmigos storefront). Product images are referenced by URL only "
                "and are not copied into this repository."
            ),
            "calls": raw_block,
            "parser": "plain HTTPS GET + JSON parse; no OCR, no scraping of HTML",
        },
    }


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


RENDERED_RE = re.compile(
    r"([^\n]{2,70})\n\n(\d{1,3},\d{2})\s*€\n\n(\d{1,3},\d{2})\s*€"
)


def verify_rendered(venue: dict, path: Path) -> int:
    """Cross-check venue.json prices against the text a browser rendered.

    The ordering page prints every item as  <name> / <price> € / <pickup price> €,
    which is the venue's own presentation of the same numbers. Agreement here
    means the adapter did not mis-read the JSON.
    """
    def norm(s: str) -> str:
        # the API writes "0,5\u00a0l" (NBSP), the rendered page "0,5 l"
        return re.sub(r"\s+", " ", (s or "").replace("\u00a0", " ")).strip()

    text = path.read_text(encoding="utf-8")
    seen: dict[str, tuple[float, float]] = {}
    for m in RENDERED_RE.finditer(text):
        name = norm(m.group(1))
        if name in seen:
            continue
        seen[name] = (float(m.group(2).replace(",", ".")), float(m.group(3).replace(",", ".")))

    by_name = {}
    for it in venue["menu"]["items"]:
        by_name.setdefault(norm(it["name"]), it)

    checked, mismatch, missing = 0, [], []
    for name, (page_price, page_pickup) in seen.items():
        it = by_name.get(name)
        if not it:
            missing.append(name)
            continue
        checked += 1
        if abs((it["price"] or -1) - page_price) > 1e-9:
            mismatch.append(f"{name}: api={it['price']} page={page_price}")
        pickup = it["prices_by_order_method"].get("pickup")
        if pickup is not None and abs(pickup - page_pickup) > 1e-9:
            mismatch.append(f"{name} (pickup): api={pickup} page={page_pickup}")

    print(f"RENDERED CROSS-CHECK items_on_page={len(seen)} matched={checked} "
          f"not_in_venue_json={len(missing)} mismatches={len(mismatch)}")
    for name in missing[:20]:
        print("  not-matched (page text the item-name regex also caught):", repr(name))
    for line in mismatch:
        print("  MISMATCH", line)
    return 1 if (mismatch or checked < 10) else 0


def run(args) -> int:
    raw_dir = Path(args.raw_dir)
    venue_path = Path(args.venue)

    if args.refetch_fulfilment:
        print(f"re-deriving fulfilment facts from {CONFIG['storefront_origin']} "
              f"(store + company calls only) ...", file=sys.stderr)
        fetch_fulfilment_only(raw_dir)

    if args.fetch or not (raw_dir / "menus.json").exists():
        print(f"fetching {CONFIG['storefront_origin']} ...", file=sys.stderr)
        fetch_all(raw_dir)

    store, company, menus, _prov = load_raw(raw_dir)
    venue = build_venue(store, company, menus, raw_dir)
    blob = (json.dumps(venue, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    digest = sha256_hex(blob)

    if args.selftest:
        _r1_regression()
        blob2 = (json.dumps(build_venue(*[json.loads(json.dumps(x)) for x in (store, company, menus)],
                                       raw_dir),
                            ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        assert blob == blob2, "non-deterministic build"
        st = venue["menu"]["stats"]
        assert st["items_priced_listed"] >= 10, f"only {st['items_priced_listed']} priced items"
        assert st["sections"] >= 1, "no sections"
        skus = {i["sku"] for i in venue["menu"]["items"]}
        assert len(skus) == len(venue["menu"]["items"]), "duplicate sku in items"
        for i in venue["menu"]["items"]:
            assert i["price"] is None or i["price"] > 0, f"bad price for {i['sku']}"
        print("SELFTEST OK deterministic=1 duplicate_skus=0 priced=+"
              f"{st['items_priced_listed']} sections={st['sections']}")

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
    ap.add_argument("--fetch", action="store_true", help="force re-fetch from the source")
    ap.add_argument("--refetch-fulfilment", action="store_true", dest="refetch_fulfilment",
                    help="re-fetch ONLY the store + company calls and re-derive the "
                         "fulfilment fields (delivery area/availability, opening hours). "
                         "The menus call is deliberately NOT re-fetched, so no price churns.")
    ap.add_argument("--check", action="store_true", help="rebuild and compare with venue.json")
    ap.add_argument("--selftest", action="store_true", help="determinism + invariant assertions")
    ap.add_argument("--verify-rendered", metavar="FILE",
                    help="cross-check prices against a browser-rendered page dump")
    return run(ap.parse_args())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (urllib.error.URLError, RuntimeError) as exc:  # network / build failure
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
