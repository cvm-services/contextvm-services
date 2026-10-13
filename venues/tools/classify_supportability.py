#!/usr/bin/env python3
"""Which venues are FoodAmigos storefronts (= have a real online checkout)?

The earlier page-scrape probe was unreliable: 429/403 rate-limiting produced
false negatives, including for three-buddies whose checkout we have already
walked and whose Stripe bundle we have already extracted. So do not classify by
scraping the page.

Authoritative signal instead: the storefront platform answers
  GET https://app.foodamigos.io/api/store-config?hostname=<host>
for a host it serves. A 200 with store config means the host IS a FoodAmigos
storefront, i.e. it has the same online checkout API we mapped
(POST /order-drafts, /stripe/payment-intents, Stripe Elements).

Read-only GETs, paced (one at a time, 1.5s apart) to respect their rate limits.
"""
from __future__ import annotations

import json
import pathlib
import time
import urllib.parse
import urllib.error
import urllib.request

VENUES = pathlib.Path("/home/c08r4d0r/repos/contextvm-services/venues")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
API = "https://app.foodamigos.io/api/store-config"


def store_config(hostname: str) -> dict:
    url = f"{API}?hostname={urllib.parse.quote(hostname)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read(80_000).decode("utf-8", "ignore")
            try:
                data = json.loads(raw)
            except Exception:
                data = {}
            return {"hostname": hostname, "status": r.status,
                    "is_storefront": r.status == 200 and isinstance(data, dict) and bool(data),
                    "company": str(data.get("company_id") or data.get("id") or "")[:20] if isinstance(data, dict) else "",
                    "bytes": len(raw)}
    except urllib.error.HTTPError as e:
        return {"hostname": hostname, "status": e.code, "is_storefront": False}
    except Exception as e:
        return {"hostname": hostname, "error": str(e)[:60], "is_storefront": False}


def main() -> int:
    rows = []
    for vj in sorted(VENUES.glob("*/venue.json")):
        d = json.loads(vj.read_text())
        v = d.get("venue", {})
        o = (v.get("ordering") or {})
        urls = o.get("urls") or {}
        shop = urls.get("platform_shop") or urls.get("external_web_shop")
        # The host that would serve a storefront: the platform shop if declared,
        # else the venue's own primary page host.
        candidates = [u for u in [shop, o.get("primary_url"), v.get("website")] if u]
        hosts = []
        for c in candidates:
            h = urllib.parse.urlparse(c).hostname
            if h and h not in hosts:
                hosts.append(h)
        checks = []
        for h in hosts[:2]:
            checks.append(store_config(h))
            time.sleep(1.5)
        rows.append({
            "slug": vj.parent.name,
            "platform_shop": shop,
            "primary_url": o.get("primary_url"),
            "checks": checks,
            "is_storefront": any(c.get("is_storefront") for c in checks),
        })

    print(f"{'venue':<34} {'storefront':<11} evidence")
    print("-" * 104)
    for r in rows:
        ev = "; ".join(f"{c['hostname']}->{c.get('status', c.get('error'))}" for c in r["checks"])[:60]
        print(f"{r['slug']:<34} {str(r['is_storefront']):<11} {ev}")

    yes = [r["slug"] for r in rows if r["is_storefront"]]
    no = [r["slug"] for r in rows if not r["is_storefront"]]
    print(f"\nONLINE CHECKOUT (FoodAmigos storefront) — SUPPORTABLE: {yes}")
    print(f"NO ONLINE CHECKOUT — cannot support in sats: {no}")
    pathlib.Path("/tmp/venue-supportability.json").write_text(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
