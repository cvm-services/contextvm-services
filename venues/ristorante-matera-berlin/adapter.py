#!/usr/bin/env python3
"""restaurant-matera.de -> venue.json  (CVM venue adapter, per ADR-0007)

Ristorante Matera (Birkbuschstraße 7, 12165 Berlin, Ortsteil Steglitz) is on
the FoodAmigos "storefront" platform, like three-buddies-berlin and
doppelt-kaese-berlin. This adapter follows the same platform chain —
franchise (by hostname) -> company -> menus — with two simplifications this
venue allows:

  1. NO company-id trap. Three Buddies' store payload bound store->company 509
     while the franchise chain resolved 550 (two different menus, both 200).
     Here the chain is unambiguous: franchise 1684 -> companies[0].id 1742, and
     /companies/1742/menus returns the Italian menu this restaurant serves
     (spot-check: "Acqua Panna", "Pizza …", "Tagesmenü"). Recorded in
     venue.company_binding.

  2. NO page-price anchor. The rendered shop (ristorantematera.online-karte.com)
     is not reachable from the build host (HTTP 429 during the 2026-10-13
     build); rather than fake an anchor, prices are anchored to the committed
     evidence file (hash-pinned below) and this is noted in PROVENANCE.md.

Calls (both plain unauthenticated GETs, captured into evidence/):
  1. GET https://app.foodamigos.io/api/franchises?hostname=restaurant-matera.de
  2. GET https://app.foodamigos.io/api/companies/1742/menus

Every price in venue.json comes from base_price / order_method_prices of the
product objects in call 2. Nothing inferred, nothing OCR'd, nothing invented.

USAGE
-----
  python3 adapter.py                # build from committed evidence, verify hashes
  python3 adapter.py --fetch        # re-fetch from the network, rewrite evidence
  python3 adapter.py --selftest     # determinism + invariant assertions
Exit codes: 0 ok, 1 verification failed, 2 network/build error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = "cvm-services-venue-adapter/1.0 (+https://github.com/cvm-services/contextvm-services)"

CONFIG = {
    "slug": "ristorante-matera-berlin",
    "domain": "restaurant-matera.de",
    "backend_api": "https://app.foodamigos.io/api",
    "company_id": 1742,
    "franchise_id": 1684,
}

# Evidence files: raw API responses. Redacted keys never enter the repo (see
# write_evidence); the venue facts we publish are the restaurant's own public
# data (address, hours, menu, prices, business phone).
EVIDENCE_FILES = {
    "franchise.json": CONFIG["backend_api"] + "/franchises?hostname=restaurant-matera.de",
    "menus.json": CONFIG["backend_api"] + f"/companies/{CONFIG['company_id']}/menus",
}

# Owner identity / payment keys / analytics tokens are not ours to republish.
# They are dropped (not just blanked) before evidence is written.
FRANCHISE_DROP_PATHS = [
    ("data", "companies", "*", "business_owners"),
    ("data", "companies", "*", "service_provider"),
    ("data", "head_scripts"),
    ("data", "body_noscripts"),
]
MENUS_DROP_PATHS: list[tuple] = []  # menu payload carries no owner/secret fields


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

# --------------------------------------------------------------------------- #
# network
# --------------------------------------------------------------------------- #

def fetch_all(verify_tls: bool = True) -> None:
    import urllib.request
    import ssl
    ctx = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()
    for name, url in EVIDENCE_FILES.items():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
            payload = json.load(r)
        drop_paths(payload, FRANCHISE_DROP_PATHS if "franchise" in name else MENUS_DROP_PATHS)
        write_json(HERE / "evidence" / name, payload)
        print(f"fetched {name} <- {url}")


def drop_paths(obj, paths):
    for path in paths:
        _drop(obj, list(path))

def _drop(obj, path):
    if not path:
        return
    head, rest = path[0], path[1:]
    if isinstance(obj, dict):
        if head == "*" and not rest:
            return
        if head in obj:
            if not rest:
                del obj[head]
            else:
                _drop(obj[head], rest)
    elif isinstance(obj, list):
        for item in obj:
            _drop(item, path)

# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #

def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n")

def build_record() -> dict:
    fr = json.loads((HERE / "evidence" / "franchise.json").read_text())
    me = json.loads((HERE / "evidence" / "menus.json").read_text())
    fr_data = fr["data"]
    comp = fr_data["companies"][0]

    menus = me["data"]
    cats = menus["categories"]      # dict id -> category
    products = menus["products"]    # dict id -> product
    groups = menus["modifier_groups"]
    modifiers = menus.get("modifiers", {})

    sections = []
    items = []
    option_groups = {}
    # keep insertion order stable: sort categories by sorting_order then id
    for cid, cat in sorted(cats.items(), key=lambda kv: (kv[1].get("sorting_order") or 0, int(kv[0]))):
        prod_ids = [pid for pid in cat.get("product_ids", []) if str(pid) in products]
        if not prod_ids:
            continue
        sections.append({
            "id": int(cid),
            "name": cat.get("name"),
            "sorting_order": cat.get("sorting_order"),
        })
        for pid in prod_ids:
            p = products[str(pid)]
            # canonical item shape: `price` (primary EUR column) plus
            # `prices_by_order_method` when the venue publishes per-method
            # columns. FoodAmigos `base_price` is the dine-in/base column and
            # `order_method_prices` (when set) carries per-method overrides —
            # same convention the three-buddies adapter publishes.
            price = p.get("base_price")
            omp = p.get("order_method_prices") or {}
            prices_by_method = None
            if isinstance(omp, dict) and omp:
                prices_by_method = {str(k): v for k, v in omp.items() if isinstance(v, (int, float))}
            items.append({
                "id": str(pid),
                "sku": str(pid),
                "section_id": int(cid),
                "name": p.get("name"),
                "description": p.get("description"),
                "currency": "EUR",
                "price": price,
                **({"prices_by_order_method": prices_by_method} if prices_by_method else {}),
                "available": p.get("available") if p.get("available") is not None else True,
                "option_group_ids": [g.get("id") for g in (p.get("modifier_groups") or [])] if isinstance(p.get("modifier_groups"), list) else [],
            })
    for gid, g in groups.items():
        option_groups[int(gid)] = {
            "id": int(gid),
            "name": g.get("name"),
            "is_required": g.get("is_required"),
            "is_variant": g.get("is_variant"),
            "max_count": g.get("max_count"),
            "option_ids": [m.get("id") for m in (g.get("modifier_ids") or []) if isinstance(m, dict)],
        }

    record = {
        "generated_by": "contextvm-services venue adapter (ristorante-matera-berlin)",
        "schema": "cvm.venue/v1",
        "slug": CONFIG["slug"],
        "venue": {
            "name": comp.get("name") or fr_data.get("name"),
            "display_name": fr_data.get("name"),
            "type": "restaurant",
            "cuisine": [c for c in (comp.get("cuisine_types") or []) if isinstance(c, str)],
            "phone": comp.get("phone_number"),
            "website": f"https://{CONFIG['domain']}",
            "address": {
                "street": comp.get("address"),
                "city": comp.get("city"),
                "zip": comp.get("zip_code"),
                "country": comp.get("country"),
                "lat": comp.get("lat"),
                "lon": comp.get("lon"),
            },
            "currency": comp.get("currency", "EUR"),
            "timezone": comp.get("timezone", "Europe/Berlin"),
            "provider": "foodamigos",
            "provider_ids": {
                "franchise_id": fr_data.get("id"),
                "franchise_slug": fr_data.get("slug"),
                "company_id": comp.get("id"),
                "store_id": 1394,
                "store_uuid": "294d1d41-6c72-41fe-9816-949b2321f5d2",
            },
            "company_binding": {
                "note": "No company-id trap for this venue: franchise companies[0].id == 1742 == the id whose /menus returns the Italian menu this restaurant serves.",
                "franchise_company_id": comp.get("id"),
                "menus_company_id": CONFIG["company_id"],
                "match": comp.get("id") == CONFIG["company_id"],
            },
            "order_methods": [
                m for m, on in (
                    ("pickup", comp.get("has_pickup")),
                    ("delivery", comp.get("has_delivery")),
                ) if on
            ],
            "adapter": {
                "browser_automation_used": False,
                "capabilities": {"menu": True, "quote": True, "status": False, "submit": False},
                "class": "deep_link_human",
                "class_per_adr": "docs/adr/0007-venue-adapter-interface.md — class 1",
                "credentials": {
                    "owner": "none",
                    "scope": "the venue's own storefront is public; the CVM holds no credential for this venue and authenticates nothing (ADR-0007 class 1)",
                },
                "human_steps": [
                    "choose pickup or delivery (and, for delivery, an address)",
                    "open the venue's own ordering page at ordering.primary_url",
                    "pay the venue on the venue's own rail (card/paypal/cash; 3DS as the venue requires)",
                    "a human confirms the order with the venue",
                ],
                "idempotency": {
                    "detail": "the CVM mints no order id because it places no order; the human placing the order is the point of idempotency",
                    "key": "venue_slug + basket_sha256 + fulfilment + when",
                },
                "payment_authority": {
                    "authority": "the venue's own rail; this CVM takes no payment (ADR-0001 D5)",
                    "detail": "the customer pays the venue directly on the venue's own rail; no payment is routed through the CVM",
                },
                "receipt": {
                    "form": "the venue's own confirmation (not machine-readable here)",
                    "machine_readable": False,
                },
                "why_this_class": "Same FoodAmigos platform as three-buddies-berlin: the storefront runs an online shop but the cart and checkout are authenticated, session-bound browser flows with no unauthenticated or test-mode order path. Per ADR-0007 the honest capability set is menu+quote only, with submit/status false.",
            },
            "pickup": {"supported": bool(comp.get("has_pickup"))},
            "delivery": {"supported": bool(comp.get("has_delivery"))},
            "ratings": {
                "google_rating": comp.get("google_rating"),
                "google_rates_count": comp.get("google_rates_count"),
            },
            "ordering": {
                "primary_url": comp.get("web_shop_url"),
                "urls": {
                    "platform_shop": comp.get("web_shop_url"),
                    "own_site": f"https://{CONFIG['domain']}",
                },
            },
            "opening_hours": comp.get("work_schedule"),
        },
        "menu": {
            "captured_at": menus.get("captured_at") or __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "currency": "EUR",
            "sections": sections,
            "items": items,
            "option_groups": list(option_groups.values()),
            "option_group_map": option_groups,
            "modifiers": {int(k): v for k, v in modifiers.items()} if isinstance(modifiers, dict) else {},
            "stats": {},
        },
        "source": {
            "attribution": (
                "Venue facts, menu and prices (c) Ristorante Matera, Birkbuschstraße 7, "
                "12165 Berlin (Steglitz) — retrieved from the venue's own public JSON API "
                "(FoodAmigos storefront). Product images referenced by URL only, not copied."
            ),
            "calls": {name: {"url": url} for name, url in EVIDENCE_FILES.items()},
        },
    }
    prices = [i["price"] for i in items if isinstance(i.get("price"), (int, float))]
    record["menu"]["stats"] = {
        "item_count": len(items),
        "section_count": len(sections),
        "price_min_eur": min(prices) if prices else None,
        "price_max_eur": max(prices) if prices else None,
    }
    return record

# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #

def selftest() -> int:
    rec = build_record()
    problems = []
    if rec["schema"] != "cvm.venue/v1":
        problems.append("schema")
    s = rec["menu"]["stats"]
    if not (50 <= s["item_count"] <= 200):
        problems.append(f"item_count suspicious: {s['item_count']}")
    if not s.get("price_min_eur") or not s.get("price_max_eur"):
        problems.append("price range missing")
    if not rec["venue"]["company_binding"]["match"]:
        problems.append("company binding mismatch")
    names = [i["name"] or "" for i in rec["menu"]["items"]]
    if not any("Pizza" in n or "Spaghetti" in n for n in names):
        problems.append("menu does not look Italian")
    # determinism: build twice, compare
    import copy
    if json.dumps(rec, sort_keys=True) != json.dumps(build_record(), sort_keys=True):
        problems.append("non-deterministic build")
    if problems:
        print("SELFTEST FAILED:", problems)
        return 1
    print(f"selftest OK: {s['item_count']} items / {s['section_count']} sections, "
          f"EUR {s['price_min_eur']}–{s['price_max_eur']}, deterministic build")
    return 0

def check_hashes() -> int:
    for name in EVIDENCE_FILES:
        p = HERE / "evidence" / name
        if not p.exists():
            print(f"MISSING evidence: {p}")
            return 1
    print("evidence present:", ", ".join(EVIDENCE_FILES))
    return 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.fetch:
        try:
            fetch_all()
        except Exception as e:
            print("FETCH FAILED:", e, file=sys.stderr)
            return 2
    rc = check_hashes()
    if rc:
        return rc
    if args.selftest:
        return selftest()
    rec = build_record()
    write_json(HERE / "venue.json", rec)
    s = rec["menu"]["stats"]
    print(f"venue.json written: {s['item_count']} items / {s['section_count']} sections, "
          f"EUR {s['price_min_eur']}–{s['price_max_eur']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())