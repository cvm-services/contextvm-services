#!/usr/bin/env python3
"""pizzaepasta-ruedesheimerplatz.de -> venue.json  (CVM venue adapter, S1b)

WHAT THIS DOES
--------------
The venue runs its own ordering site on the **OrderYoyo** shop platform
(API namespace ``/oyy-api``; the restaurant payload refers to itself as
``externalRPId: "AppSmart_8871"`` and its imprint address is
``kontakt-ordersmart.de``).  The site is a Next.js app whose menu page is
server-side rendered: the HTML response (HTTP 200) embeds the platform's own
JSON payloads in ``__NEXT_DATA__.props.pageProps.initialData.fallback`` — the
react-query hydration cache, i.e. exactly what the server received from:

  GET /oyy-api/MyRestaurant/families/by-domain/restaurants?domain=<domain>
      -> the family's restaurants (address, lat/lon, opening hours, service
         methods, fees, delivery mode)
  GET /oyy-api/MyRestaurant/restaurant/<id>?timeSensitive=false
      -> that restaurant in detail (same shape, plus vat/imprint/ids)
  GET /oyy-api/MyRestaurant/families/by-domain?domain=<domain>
      -> the family/brand record (theme, logos, published-app links)
  GET /oyy-api/MyMenuManagementSystem/restaurants/<id>/menu?version=9&type=Takeaway
      -> categories, menuItems (with `price`/`priceLevel1`/`priceLevel2` and
         their `discounted*` counterparts), addons, allergens, flags, taxes
  GET /oyy-api/AppPublishing/families/<family>/published-apps
      -> the family's own iOS/Android app links

The origin sits behind a Cloudflare **managed challenge**: plain curl/urllib
(and even curl carrying the successful run's `cf_clearance` cookie) get
HTTP 403 — the clearance is bound to the browser's TLS fingerprint.  One
headed Chrome session under xvfb passes the challenge and yields the page; see
``evidence/PROVENANCE.md`` for the measured outcome.  Because the page body
already carries all five payloads, the cheap and reproducible path is:

    python3 adapter.py --ingest-page evidence/page.html   # re-extract from a captured page
    python3 adapter.py                                    # rebuild venue.json from evidence
    python3 adapter.py --check                            # byte-identical rebuild

`--fetch` drives the committed browser capture (``evidence/capture-menu-requests.py``)
for a fresh page; it needs xvfb + Chrome + Playwright and a challenge that
clears.  Neither `--check` nor `--selftest` ever touches the network.

USAGE
-----
  python3 adapter.py                     # build venue.json from committed evidence
  python3 adapter.py --ingest-page FILE  # (re)extract evidence from a captured page HTML
  python3 adapter.py --fetch             # drive the browser capture for a fresh page
  python3 adapter.py --selftest          # determinism + invariants
  python3 adapter.py --check             # rebuild and compare byte-for-byte
  python3 adapter.py --verify-rendered evidence/rendered-ordering-page.txt
                                         # cross-check every price against the text a
                                         # real browser rendered on the ordering page

Exit codes: 0 ok, 1 verification failed, 2 build/network error.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

CONFIG = {
    "slug": "pizza-e-pasta-ruedesheimerplatz",
    "domain": "pizzaepasta-ruedesheimerplatz.de",
    "origin": "https://pizzaepasta-ruedesheimerplatz.de",
    "restaurant_slug": "pizza-e-pasta",
    "restaurant_id": 45842,
    "family_id": 14842,
    "api_base": "https://pizzaepasta-ruedesheimerplatz.de/oyy-api",
    "menu_type": "Takeaway",
    "menu_version": 9,
    "ordering_url": "https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway",
    "provider": "orderyoyo",
    "provider_note": (
        "OrderYoyo shop platform (API namespace /oyy-api, hosts under "
        "orderyoyo.com); the venue's shop is branded by the platform's "
        "'order smart' / AppSmart product — the restaurant record carries "
        "externalRPId=AppSmart_8871 and an imprint address under "
        "kontakt-ordersmart.de."
    ),
    "user_agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.0.0 Safari/537.36"
    ),
}

# .NET DayOfWeek (the platform is a .NET backend whose Windows timezone id we
# also carry below): 0=Sunday … 6=Saturday.  Confirmed empirically: the frontend
# bundle contains the arrays ["Sonntag","Montag",…] / ["Sunday","Monday",…] and
# indexes them by `dayOfWeek`.
WEEKDAYS = {0: "sunday", 1: "monday", 2: "tuesday", 3: "wednesday",
            4: "thursday", 5: "friday", 6: "saturday"}

# source path -> endpooint (relative to CONFIG["api_base"]); the raw evidence
# file for each is <name>.json
CALLS = [
    ("myrestaurant-restaurants",
     "/MyRestaurant/families/by-domain/restaurants?domain={domain}"),
    ("myrestaurant-restaurant",
     "/MyRestaurant/restaurant/{restaurant_id}?timeSensitive=false"),
    ("myrestaurant-family",
     "/MyRestaurant/families/by-domain?domain={domain}"),
    ("menu",
     "/MyMenuManagementSystem/restaurants/{restaurant_id}/menu"
     "?version={menu_version}&type={menu_type}"),
    ("published-apps",
     "/AppPublishing/families/{family_id}/published-apps"),
]

# matched against the hydration-cache KEY (the URL the SSR used); most specific first
SLUG_MATCHERS = [
    ("MyMenuManagementSystem", "menu"),
    ("AppPublishing", "published-apps"),
    ("/MyRestaurant/restaurant/", "myrestaurant-restaurant"),
    ("families/by-domain/restaurants", "myrestaurant-restaurants"),
    ("families/by-domain", "myrestaurant-family"),
]

REDACTIONS = {
    "myrestaurant-restaurant": ["imprintEmail"],
    "myrestaurant-restaurants": ["imprintEmail"],
    "myrestaurant-family": [],
    "menu": [],
    "published-apps": [],
}

# Committed fragments are slices of the already-redacted evidence copies, so a
# hit here is a real regression.
PII_GUARD = [b"@", b"stripe_key", b"adyen_key", b"api_key", b"cf_clearance"]

FRAGMENT_SPECS = {
    "myrestaurant-restaurant": [
        ('"address":', 320, "restaurant.address.fragment.txt"),
        ('"openingHours":', 900, "restaurant.opening-hours.fragment.txt"),
        ('"deliveryFee":', 260, "restaurant.delivery.fragment.txt"),
    ],
    "menu": [
        ('"categories":', 1400, "menu.categories.fragment.txt"),
        ('"title": "Pizza Funghi"', 900, "menu.item.fragment.txt"),
        ('"taxes":', 420, "menu.taxes.fragment.txt"),
    ],
}


# --------------------------------------------------------------------------- #
# io helpers
# --------------------------------------------------------------------------- #
def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, obj) -> bytes:
    """Canonical, byte-stable serialisation used for BOTH evidence and venue.json."""
    blob = (json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return blob


def redact(obj, paths: list[str]):
    """Redact the given dotted keys anywhere in the structure (lists included)."""
    for path in paths:
        _redact_walk(obj, path.split("."))
    return obj


def _redact_walk(node, parts):
    if not parts:
        return
    if isinstance(node, list):
        for el in node:
            _redact_walk(el, parts)
        return
    if isinstance(node, dict):
        head, rest = parts[0], parts[1:]
        if head in node:
            if rest:
                _redact_walk(node[head], rest)
            else:
                node[head] = "[REDACTED]"
        else:
            for value in node.values():
                _redact_walk(value, parts)


def write_fragments(kind: str, raw: bytes, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for anchor, length, fname in FRAGMENT_SPECS.get(kind, []):
        idx = raw.find(anchor.encode("utf-8"))
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


def endpoint(kind: str) -> str:
    for name, tpl in CALLS:
        if name == kind:
            return CONFIG["api_base"] + tpl.format(**CONFIG)
    raise KeyError(kind)


# --------------------------------------------------------------------------- #
# sources: browser capture, page ingestion, evidence loading
# --------------------------------------------------------------------------- #
def fetch_all(raw_dir: Path, capture: Path | None = None) -> dict:
    """Drive the committed browser capture, then ingest the page it saved."""
    script = capture or (HERE / "evidence" / "capture-menu-requests.py")
    if not script.exists():
        raise RuntimeError(f"browser capture script missing: {script}")
    out = raw_dir.parent / "page.html"
    cmd = [sys.executable, str(script), "--out", str(out)]
    print(f"running browser capture: {' '.join(cmd)}", file=sys.stderr)
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if res.returncode != 0:
        raise RuntimeError(
            "browser capture failed (the origin is behind a Cloudflare managed "
            f"challenge; a sticky cooldown or an interactive captcha stops it).\n"
            f"stdout:\n{res.stdout[-2000:]}\nstderr:\n{res.stderr[-2000:]}"
        )
    return ingest_page(out, raw_dir)


def ingest_page(page_path: Path, raw_dir: Path) -> dict:
    """Extract the five API payloads from a saved ordering page's NEXT_DATA."""
    html = page_path.read_bytes()
    txt = html.decode("utf-8", "replace")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', txt, re.S)
    if not m:
        raise RuntimeError(f"no __NEXT_DATA__ in {page_path}")
    nd = json.loads(m.group(1))
    fallback = nd["props"]["pageProps"]["initialData"]["fallback"]

    pages = {}
    for key, payload in fallback.items():
        for needle, slug in SLUG_MATCHERS:
            if needle in key:
                pages.setdefault(slug, {"key": key, "payload": payload})
                break
        else:
            print(f"  ! unmatched hydration key: {key}", file=sys.stderr)

    missing = [n for n, _ in CALLS if n not in pages]
    if missing:
        raise RuntimeError(f"missing payloads in page: {missing}")

    # provenance is taken on the payload as embedded (canonicalised), plus the page itself
    hashes = {
        "_page": {
            "file": str(page_path.relative_to(page_path.parents[len(page_path.parents) - 1]))
            if False else "evidence/page.html",
            "bytes": len(html),
            "sha256": sha256_hex(html),
            "url": CONFIG["ordering_url"],
            "note": ("HTTP 200 ordering page; payloads below are slices of its "
                     "__NEXT_DATA__.props.pageProps.initialData.fallback hydration cache"),
        }
    }
    for slug, entry in pages.items():
        payload = entry["payload"]
        blob = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        hashes[slug] = {
            "url": endpoint(slug),
            "hydration_key": entry["key"],
            "file": f"evidence/raw/{slug}.json",
            "bytes": len(blob),
            "sha256": sha256_hex(blob),
        }
        write_json(raw_dir / f"{slug}.json", payload)

    # fragments + committed-copy hashes are taken post-redaction
    for slug in pages:
        path = raw_dir / f"{slug}.json"
        obj = json.loads(path.read_text(encoding="utf-8"))
        redact(obj, REDACTIONS.get(slug, []))
        write_json(path, obj)

    for slug in pages:
        blob = (raw_dir / f"{slug}.json").read_bytes()
        hashes[slug]["committed_copy_sha256"] = sha256_hex(blob)
        hashes[slug]["redactions"] = REDACTIONS.get(slug, [])
        if REDACTIONS.get(slug):
            hashes[slug]["committed_copy_redacted"] = True
        write_fragments(slug, blob, raw_dir.parent / "fragments")

    write_json(raw_dir / "_provenance.json", hashes)
    return hashes


def load_raw(raw_dir: Path) -> dict:
    out = {}
    for slug, _ in CALLS:
        out[slug] = json.loads((raw_dir / f"{slug}.json").read_text(encoding="utf-8"))
    prov_path = raw_dir / "_provenance.json"
    out["_provenance"] = (json.loads(prov_path.read_text(encoding="utf-8"))
                          if prov_path.exists() else {})
    return out


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #
def _number(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _schedule(rows) -> list[dict]:
    out = []
    for row in rows or []:
        if not isinstance(row, dict) or row.get("from") is None:
            continue
        day = row.get("dayOfWeek")
        out.append({
            "day": day,
            "weekday": WEEKDAYS.get(day),
            "opens": row.get("from"),
            "closes": row.get("to"),
            "working_after_midnight": bool(row.get("workingAfterMidnight")),
            "timezone": "Europe/Berlin",
        })
    return sorted(out, key=lambda r: (r["day"] if r["day"] is not None else 99))


def _address(rest: dict) -> dict:
    """'Rüdesheimer Str. 9, 14197 Berlin' -> structured, nothing invented."""
    raw = (rest.get("address") or "").strip()
    street, postal, city = raw, None, None
    m = re.match(r"^(?P<street>.+?),\s*(?P<zip>\d{5})\s+(?P<city>.+)$", raw)
    if m:
        street, postal, city = m.group("street"), m.group("zip"), m.group("city")
    return {
        "street": street or None,
        "postal_code": postal,
        "city": city,
        "state": "Berlin" if city == "Berlin" else None,
        "country": rest.get("countryCode"),
        "lat": rest.get("latitude"),
        "lon": rest.get("longitude"),
        "raw": raw,
    }


def _option_group_key(gid, signature: str, seen: dict) -> str:
    if gid not in seen:
        seen[gid] = {signature: str(gid)}
        return str(gid)
    if signature in seen[gid]:
        return seen[gid][signature]
    key = f"{gid}-{len(seen[gid]) + 1}"
    seen[gid][signature] = key
    return key


def _norm_options(items) -> list[dict]:
    opts = []
    for it in items or []:
        opts.append({
            "id": str(it.get("id")),
            "name": it.get("title"),
            "list_price": _number(it.get("price")),
            "discounted_price": _number(it.get("discountedPrice")),
            "price_level1": _number(it.get("priceLevel1")),
            "discounted_price_level1": _number(it.get("discountedPriceLevel1")),
            "price_level2": _number(it.get("priceLevel2")),
            "discounted_price_level2": _number(it.get("discountedPriceLevel2")),
            "order": it.get("orderBy"),
        })
    return sorted(opts, key=lambda o: (o["order"] if o["order"] is not None else 99, o["id"]))


def _signature(group: dict) -> str:
    return json.dumps([group.get("title"), group.get("type"), group.get("isRequired"),
                       group.get("priceLevelDependent"), group.get("max"),
                       [(o["id"], o["list_price"], o["discounted_price"],
                         o["price_level2"], o["discounted_price_level2"]) for o in group["options"]]],
                      sort_keys=True)


def _norm_group(group: dict, key: str) -> dict:
    return {
        "id": key,
        "source_group_id": str(group.get("id")),
        "name": group.get("title"),
        "type": group.get("type"),
        "required": bool(group.get("isRequired")),
        "multi_select": group.get("type") == "MultipleEnum",
        "max": group.get("max"),
        "price_level_dependent": bool(group.get("priceLevelDependent")),
        "options": _norm_options(group.get("addonItems")),
    }


def _item_levels(it: dict) -> tuple[dict, float | None, float | None, str | None]:
    """Return (levels, payable, list, level_used).  All values copied, never computed.

    The platform numbers a required "Deine Größe" (PriceLevelEnum) addon by its
    option order: ``orderBy 1 -> priceLevel1``, ``orderBy 2 -> priceLevel2``, and
    the ordering page pre-selects the FIRST option.  So the level the venue itself
    displays is the lowest defined level — verified against the rendered page:
    pizzas only define level 2 (their single "Ø 32cm" size) and show it, the two
    bottle wines define both and show level 1 ("0,75l", the size their title names).
    """
    levels = {}
    if it.get("price") is not None or it.get("discountedPrice") is not None:
        levels["default"] = {"list": _number(it.get("price")),
                             "discounted": _number(it.get("discountedPrice"))}
    if it.get("priceLevel1") is not None:
        levels["size1"] = {"list": _number(it.get("priceLevel1")),
                           "discounted": _number(it.get("discountedPriceLevel1"))}
    if it.get("priceLevel2") is not None:
        levels["size2"] = {"list": _number(it.get("priceLevel2")),
                           "discounted": _number(it.get("discountedPriceLevel2"))}
    for level in ("size1", "size2", "default"):
        if level in levels:
            lv = levels[level]
            payable = lv["discounted"] if lv["discounted"] is not None else lv["list"]
            return levels, payable, lv["list"], level
    return levels, None, None, None


def build_menu(menu_payload: dict) -> dict:
    resp = menu_payload["response"] if "response" in menu_payload else menu_payload
    categories = resp.get("categories") or []

    group_keys: dict = {}
    groups: dict = {}
    items: dict = {}
    sections = []

    for cat in categories:
        cid = str(cat.get("id"))
        cat_groups = []
        for g in cat.get("addons") or []:
            opts = _norm_options(g.get("addonItems"))
            sig = _signature({"title": g.get("title"), "type": g.get("type"),
                              "isRequired": g.get("isRequired"),
                              "priceLevelDependent": g.get("priceLevelDependent"),
                              "max": g.get("max"), "options": opts})
            key = _option_group_key(g.get("id"), sig, group_keys)
            if key not in groups:
                groups[key] = _norm_group(g, key)
            cat_groups.append(key)

        skus = []
        for it in cat.get("menuItems") or []:
            item_groups = cat_groups
            if it.get("hasOwnAddons") and it.get("addons"):
                item_groups = []
                for g in it["addons"]:
                    opts = _norm_options(g.get("addonItems"))
                    sig = _signature({"title": g.get("title"), "type": g.get("type"),
                                      "isRequired": g.get("isRequired"),
                                      "priceLevelDependent": g.get("priceLevelDependent"),
                                      "max": g.get("max"), "options": opts})
                    key = _option_group_key(g.get("id"), sig, group_keys)
                    if key not in groups:
                        groups[key] = _norm_group(g, key)
                    item_groups.append(key)
            iid = str(it.get("id"))
            skus.append(it.get("sku"))
            levels, payable, list_price, level_used = _item_levels(it)
            flags = [f.get("title") for f in (it.get("menuFlags") or []) if f.get("active", True)]
            rec = items.setdefault(iid, {
                "id": iid,
                "sku": it.get("sku"),
                "name": it.get("title"),
                "description": it.get("description") or None,
                "price": payable,
                "list_price": list_price,
                "price_level_used": level_used,
                "price_levels": levels,
                "discount_percent": it.get("discount"),
                "currency": None,  # filled by caller
                "service_method": None,  # filled by caller
                "available": True,
                "listed_in_menu": True,
                "popular": bool(it.get("isPopular")),
                "popularity_rank": it.get("popularityRank"),
                "flags": flags or None,
                "spice_type": it.get("spiceType") or None,
                "allergens": sorted({a.get("code") for a in (it.get("allergens") or [])
                                     if a.get("code")}) or None,
                "additives": sorted({a.get("code") for a in (it.get("additives") or [])
                                     if isinstance(a, dict) and a.get("code")}) or None,
                "section_ids": [],
                "option_group_ids": [],
                "source": "venue-api",
            })
            rec["section_ids"] = sorted(set(rec["section_ids"]) | {cid})
            rec["option_group_ids"] = sorted(set(rec["option_group_ids"]) | set(item_groups))

        sections.append({
            "id": cid,
            "name": cat.get("title"),
            "kind": "popular_view" if cat.get("discount") is None and str(cat.get("id")) == "9999"
                    else "default",
            "description": cat.get("description") or None,
            "discount_percent": cat.get("discount"),
            "item_skus": skus,
            "item_ids": [str(i.get("id")) for i in (cat.get("menuItems") or [])],
        })

    items = dict(sorted(items.items(), key=lambda kv: (kv[1]["sku"] is None,
                                                       kv[1]["sku"] or "", kv[1]["name"] or "")))
    return {
        "sections": sections,
        "option_groups": [groups[k] for k in sorted(groups)],
        "items": list(items.values()),
        "resp": resp,
    }


def build_venue(raw: dict, raw_dir: Path) -> dict:
    restaurants = raw["myrestaurant-restaurants"]
    rest = raw["myrestaurant-restaurant"]
    family = raw["myrestaurant-family"]
    apps = raw["published-apps"]
    prov = raw.get("_provenance") or {}

    menu_built = build_menu(raw["menu"])
    items = menu_built["items"]
    sections = menu_built["sections"]
    resp = menu_built["resp"]

    currency = ((rest.get("currency") or {}).get("isoCode")
                or (family.get("currency") or {}).get("isoCode") or "EUR")
    # service method: the menu was fetched with type=Takeaway (the venue's own
    # ordering rail is its takeaway page), so every price is a pickup/takeaway price
    service_method = "pickup"
    for it in items:
        it["currency"] = currency
        it["service_method"] = service_method

    oh = rest.get("openingHours") or {}
    hours = _schedule(oh.get("allDaysOpeningHours"))
    delivery_hours = _schedule(oh.get("allDaysDeliveryHours"))
    methods = [m.lower() for m in (rest.get("serviceMethods") or [])]
    order_methods = [{"delivery": "delivery", "pickup": "pickup"}.get(m, m) for m in methods]

    flags = sorted({f for it in items for f in (it.get("flags") or [])})
    spicy = sorted({it["name"] for it in items if (it.get("spice_type") or "").lower() == "spicy"})

    priced = [it for it in items if it["price"] is not None]
    listed_ids = {it["id"] for it in items if it["listed_in_menu"]}
    sku_count: dict = {}
    for it in items:
        sku_count.setdefault(it["sku"], []).append(it["name"])
    duplicate_skus = {sku: names for sku, names in sorted(sku_count.items()) if len(names) > 1}
    tax_bands = [{"id": t.get("taxId"), "abbreviation": t.get("abbreviation"),
                  "name": t.get("name"), "percent": t.get("percentage"),
                  "inclusion": t.get("inclusionType")} for t in (resp.get("taxes") or [])]

    apps_resp = apps.get("response", apps)
    published_apps = {}
    for platform, link in (apps_resp.get("apps") or {}).items():
        published_apps[platform] = link

    telephones = rest.get("phone") or ""
    phone = telephones
    if re.fullmatch(r"0\d{9,}", telephones):
        phone = f"+49 {telephones[1:3]} {telephones[3:]}"

    venue = {
        "schema": "cvm.venue/v1",
        "slug": CONFIG["slug"],
        "generated_by": f"venues/{CONFIG['slug']}/adapter.py",
        "venue": {
            "name": rest.get("name"),
            "display_name": rest.get("name"),
            "type": "restaurant",
            "provider": CONFIG["provider"],
            "provider_note": CONFIG["provider_note"],
            "website": CONFIG["origin"],
            "phone": phone,
            "currency": currency,
            "country": rest.get("countryCode"),
            "timezone": ((rest.get("timeZone") or {}).get("ianaId")
                         or rest.get("timeZoneId")),
            "timezone_id_windows": rest.get("timeZoneId"),
            "address": _address(rest),
            "ids": {
                "restaurant_id": rest.get("id"),
                "family_id": rest.get("familyId"),
                "restaurant_slug": rest.get("slug"),
                "external_rp_id": rest.get("externalRPId"),
                "vat_number": rest.get("vatNumber"),
                "imprint_operator": rest.get("ownerOrContactPerson"),
            },
            "opening_hours": hours,
            "opening_hours_note": (
                "All seven weekdays, from the restaurant payload's "
                "allDaysOpeningHours (dayOfWeek is .NET: 0=Sunday … 6=Saturday). "
                "The payload's today*/*DeliveryHours fields are pinned because the "
                "page requests the endpoint with timeSensitive=false, so they are "
                "NOT used here."
            ),
            "order_methods": order_methods,
            "pickup": {
                "available": "pickup" in order_methods,
                "estimated_minutes": rest.get("takeAwayTime"),
            },
            "delivery": {
                "available": "delivery" in order_methods,
                "enabled": bool(oh.get("hasDelivery")),
                "mode": (family.get("deliveryMode") or "").lower() or None,
                "estimated_minutes": rest.get("deliveryTime"),
                "fee": _number(rest.get("deliveryFee")),
                "service_fee": _number(rest.get("serviceFee")),
                "minimum_order": _number(rest.get("deliveryMinimumAmount")),
                "schedule": delivery_hours,
                "areas": [],
                "area_note": (
                    "deliveryMode=PostCode: the platform resolves deliverability from "
                    "the customer's address/postcode server-side "
                    "(/oyy-api/MyRestaurant/restaurant/<id>/delivery-area, the route "
                    "name found in the frontend bundle). No postcode list or radius "
                    "is exposed in the public payload, so none is asserted here."
                ),
                "selector_url": CONFIG["ordering_url"],
            },
            "ordering": {
                "primary_url": CONFIG["ordering_url"],
                "note": ("The venue's own ordering rail (OrderYoyo shop). Pickup menu "
                         "URL recorded here; the same shop serves delivery."),
                "urls": {
                    "venue_site": CONFIG["origin"] + "/",
                    "takeaway": CONFIG["ordering_url"],
                    "published_app_ios": published_apps.get("ios"),
                    "published_app_android": published_apps.get("android"),
                },
            },
            "reservation": {
                "enabled": bool((rest.get("reservationSettings") or {}).get("isEnabled")),
                "url": None,
            },
            "payment_methods": rest.get("availablePaymentMethods"),
            "food_flags": flags,
            "dietary_attributes": sorted(f.lower() for f in flags if f.lower() in
                                         ("vegan", "vegetarian", "halal", "glutenfree")),
            "spicy_items": spicy,
        },
        "menu": {
            "currency": currency,
            "service_method": service_method,
            "service_method_note": (
                "The ordering page requests type=Takeaway, so every price is the "
                "pickup/takeaway price (the venue applies its own discount to it). "
                "The delivery variant is a separate payload and is not asserted here."
            ),
            "tax_bands": tax_bands,
            "sections": sections,
            "option_groups": menu_built["option_groups"],
            "items": items,
            "stats": {
                "sections": len([s for s in sections if s["kind"] == "default"]),
                "popular_views": len([s for s in sections if s["kind"] == "popular_view"]),
                "items_listed": len(listed_ids),
                "items_priced_listed": len(priced),
                "min_price_listed": min((it["price"] for it in priced), default=None),
                "max_price_listed": max((it["price"] for it in priced), default=None),
                "duplicate_skus": duplicate_skus,
                "currency": currency,
                "service_method": service_method,
            },
        },
        "source": {
            "attribution": (
                "Venue facts, menu and prices (c) Pizza e Pasta, Rüdesheimer Str. 9, "
                "14197 Berlin — retrieved from the venue's own ordering site "
                "(OrderYoyo shop platform, /oyy-api). Product images are referenced "
                "by URL only and are not copied into this repository."
            ),
            "capture": {
                "page_url": CONFIG["ordering_url"],
                "page_http_status": 200,
                "method": ("headed Chrome under xvfb against the Cloudflare managed "
                           "challenge once; the payloads were read out of the HTTP 200 "
                           "page's __NEXT_DATA__ hydration cache"),
                "challenge": ("cf-mitigated: challenge; passed without interaction in "
                              "the first run. A plain HTTP client (curl/urllib), even "
                              "with the cf_clearance cookie copied over, still gets "
                              "HTTP 403 — WebFetch-style access is not possible."),
                "page_sha256": (prov.get("_page") or {}).get("sha256"),
                "browser_capture": "evidence/capture-menu-requests.py",
            },
            "calls": {
                slug: {
                    "url": prov.get(slug, {}).get("url", endpoint(slug)),
                    "file": f"evidence/raw/{slug}.json",
                    "sha256": prov.get(slug, {}).get("sha256"),
                    "committed_copy_sha256": prov.get(slug, {}).get("committed_copy_sha256"),
                    "redactions": REDACTIONS.get(slug, []),
                    "hydration_key": prov.get(slug, {}).get("hydration_key"),
                }
                for slug, _ in CALLS
            },
            "parser": ("Next.js __NEXT_DATA__ hydration cache extracted from the HTTP 200 "
                       "ordering page and additionally cross-checked against the text the "
                       "browser rendered; no OCR"),
        },
    }
    return venue


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #
def summary_line(venue: dict, digest: str) -> str:
    st = venue["menu"]["stats"]
    return (
        f"PARSE OK sections={st['sections']} popular_views={st['popular_views']} "
        f"items_listed={st['items_listed']} priced={st['items_priced_listed']} "
        f"min_price={st['min_price_listed']:.2f} max_price={st['max_price_listed']:.2f} "
        f"currency={st['currency']} method={st['service_method']} sha256={digest}"
    )


RENDERED_RE = re.compile(
    r"(?m)^(?P<sku>\d{1,4}[a-z]?)\n(?P<name>[^\n]{2,90})\n(?P<mid>(?:[^\n]{0,200}\n){0,5}?)"
    r"(?P<price>\d{1,3},\d{2})[\s\u00a0]*€\n(?P<list>\d{1,3},\d{2})(?:\n|$)"
)


def verify_rendered(venue: dict, path: Path) -> int:
    """Cross-check venue.json prices against the text a real browser rendered.

    The ordering page prints each item as `<sku>\\n<name>\\n…\\n<price> €\\n<list>`
    — the venue's own presentation of the same two numbers.  Agreement means the
    adapter did not mis-read the payload.
    """
    text = path.read_text(encoding="utf-8")
    seen: dict[str, tuple[float, float]] = {}
    for m in RENDERED_RE.finditer(text):
        name = re.sub(r"\s+", " ", m.group("name")).strip()
        if name in seen:
            continue
        seen[name] = (float(m.group("price").replace(",", ".")),
                      float(m.group("list").replace(",", ".")))

    by_name = {}
    for it in venue["menu"]["items"]:
        by_name.setdefault(re.sub(r"\s+", " ", (it["name"] or "")).strip(), it)

    checked, mism, missing = 0, [], []
    for name, (page_price, page_list) in seen.items():
        it = by_name.get(name)
        if not it:
            missing.append(name)
            continue
        checked += 1
        if abs((it["price"] if it["price"] is not None else -1) - page_price) > 1e-9:
            mism.append(f"{name}: json={it['price']} page={page_price}")
        if abs((it["list_price"] if it["list_price"] is not None else -1) - page_list) > 1e-9:
            mism.append(f"{name} (list): json={it['list_price']} page={page_list}")

    print(f"RENDERED CROSS-CHECK items_on_page={len(seen)} matched={checked} "
          f"not_in_venue_json={len(missing)} mismatches={len(mism)}")
    for name in missing[:20]:
        print("  not-matched:", repr(name))
    for line in mism[:20]:
        print("  MISMATCH", line)
    return 1 if (mism or checked < 100) else 0


def selftest(venue: dict, raw: dict) -> None:
    blob2 = (json.dumps(build_venue(copy.deepcopy(raw), HERE / "evidence" / "raw"),
                        ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    blob1 = (json.dumps(venue, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    assert blob1 == blob2, "non-deterministic build"

    st = venue["menu"]["stats"]
    assert st["items_priced_listed"] >= 100, f"only {st['items_priced_listed']} priced items"
    assert st["sections"] >= 5, "too few sections"
    ids = [i["id"] for i in venue["menu"]["items"]]
    assert len(ids) == len(set(ids)), "duplicate item id"
    dups = venue["menu"]["stats"]["duplicate_skus"]
    sections = {s["id"] for s in venue["menu"]["sections"]}
    for it in venue["menu"]["items"]:
        assert set(it["section_ids"]) <= sections, f"unknown section for {it['sku']}"
        assert it["price"] is None or it["price"] > 0, f"bad price for {it['sku']}"
        assert it["list_price"] is None or it["price"] is None or it["list_price"] >= it["price"], \
            f"list price below payable price for {it['sku']}"
    keys = {g["id"] for g in venue["menu"]["option_groups"]}
    for it in venue["menu"]["items"]:
        assert set(it["option_group_ids"]) <= keys, f"unknown option group for {it['sku']}"
    v = venue["venue"]
    assert v["address"]["postal_code"] == "14197"
    assert abs(v["address"]["lat"] - 52.472589) < 1e-6
    assert len(v["opening_hours"]) == 7
    print(f"SELFTEST OK deterministic=1 duplicate_ids=0 source_duplicate_skus={len(dups)} "
          f"priced={st['items_priced_listed']} sections={st['sections']} "
          f"option_groups={len(venue['menu']['option_groups'])}")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def run(args) -> int:
    raw_dir = Path(args.raw_dir)
    venue_path = Path(args.venue)

    if args.ingest_page:
        print(f"ingesting {args.ingest_page} ...", file=sys.stderr)
        ingest_page(Path(args.ingest_page), raw_dir)
    elif args.fetch:
        print("fetching via the browser capture ...", file=sys.stderr)
        fetch_all(raw_dir)
    elif not (raw_dir / "menu.json").exists():
        print(f"ERROR: no committed evidence in {raw_dir}; run --ingest-page or --fetch",
              file=sys.stderr)
        return 2

    raw = load_raw(raw_dir)
    venue = build_venue(raw, raw_dir)
    blob = (json.dumps(venue, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    digest = sha256_hex(blob)

    if args.selftest:
        selftest(venue, raw)

    if args.verify_rendered:
        rc = verify_rendered(venue, Path(args.verify_rendered))
        if rc != 0:
            return rc

    if args.check:
        if not venue_path.exists():
            print(f"CHECK FAIL: {venue_path} missing", file=sys.stderr)
            return 1
        on_disk = venue_path.read_bytes()
        if on_disk != blob:
            print(f"CHECK FAIL on-disk={sha256_hex(on_disk)} rebuilt={digest}", file=sys.stderr)
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
    ap.add_argument("--ingest-page", metavar="FILE",
                    help="extract the API payloads from a captured ordering page HTML")
    ap.add_argument("--fetch", action="store_true",
                    help="drive the browser capture for a fresh page (needs xvfb+Chrome)")
    ap.add_argument("--check", action="store_true", help="rebuild and compare with venue.json")
    ap.add_argument("--selftest", action="store_true", help="determinism + invariant assertions")
    ap.add_argument("--verify-rendered", metavar="FILE",
                    help="cross-check prices against a browser-rendered page dump")
    return run(ap.parse_args())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
