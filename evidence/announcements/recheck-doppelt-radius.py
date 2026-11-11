#!/usr/bin/env python3
"""Re-derive the retraction's factual basis for doppelt-kaese-berlin.

The retraction of `data.delivery_areas` (15 Berlin district NAMES) rests on one
claim: the venue's OWN rail publishes its delivery area as a single circle of
5000 m centred on the venue's own coordinates, and most of the named districts
lie outside it. This script recomputes that from the two values now recorded in
`venues/doppelt-kaese-berlin/venue.json`:

  - centre  = venue.address.lat/lon   (52.4707069, 13.3202819, Laubacher Str. 11)
  - radius  = venue.delivery.zones[0].radius_m (5000)

District positions are APPROXIMATE centroids (public knowledge, not a rail
value), so this is a sanity bound, not a precision measurement: the verdict is
only used to answer "inside or outside a 5 km circle", and every margin is
kilometres, far larger than the centroid error.
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENUE = HERE.parent.parent / "venues" / "doppelt-kaese-berlin" / "venue.json"

# approximate district centroids (lat, lon)
DISTRICTS = {
    "Mitte": (52.5170, 13.4050),
    "Kreuzberg": (52.4980, 13.4030),
    "Friedrichshain": (52.5150, 13.4540),
    "Prenzlauer Berg": (52.5400, 13.4240),
    "Tiergarten": (52.5140, 13.3500),
    "Moabit": (52.5300, 13.3400),
    "Wedding": (52.5500, 13.3500),
    "Charlottenburg": (52.5050, 13.3050),
    "Schöneberg": (52.4820, 13.3550),
    "Neukölln": (52.4750, 13.4400),
    "Tempelhof": (52.4650, 13.3850),
    "Wilmersdorf": (52.4850, 13.3150),
    "Lichtenberg": (52.5150, 13.5000),
    "Treptow": (52.4900, 13.4500),
    "Pankow.": (52.5690, 13.4020),
}


def haversine(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def main():
    v = json.loads(VENUE.read_text())
    addr = v["venue"]["address"]
    centre = (addr["lat"], addr["lon"])
    zone = v["venue"]["delivery"]["zones"][0]
    radius = zone["radius_m"]
    print(f"venue: {addr['street']}, {addr['postal_code']} {addr['city']} ({addr['quarter']})")
    print(f"centre {centre} (venue's own coordinates) radius {radius} m")
    print(f"zone name '{zone['name']}' min_order {zone['min_order']} fee {zone['fee']} {zone['currency']}")
    inside, outside = [], []
    for name, pos in DISTRICTS.items():
        d = haversine(centre, pos)
        (inside if d <= radius else outside).append((name, d))
        print(f"  {name:18} {d/1000:7.2f} km  {'INSIDE' if d <= radius else 'outside'}")
    print()
    print(f"inside: {len(inside)} -> {[n for n, _ in inside]}")
    print(f"outside: {len(outside)} of {len(DISTRICTS)} -> {[f'{n} {d/1000:.1f}km' for n, d in outside]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
