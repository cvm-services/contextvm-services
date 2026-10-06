/**
 * geohash.ts — dependency-free geohash encoding for venue locations.
 *
 * CEP-6 P2 / ADR-0001 D3: a provider MUST publish its location as a geohash at
 * two or more precisions, because `#g` is exact-match — the publisher
 * pre-computes the precision, the client cannot ask for "near". This module
 * produces the precision ladder the emitter needs.
 *
 * Alphabet and interleaving are the standard base32 geohash (NIP-52).
 */

/** Standard geohash base32 alphabet (no a, i, l, o). */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Encode a single lat/lon point to a geohash of the given precision. */
export function encodeGeohash(lat: number, lon: number, precision: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`geohash: lat/lon must be finite, got (${lat}, ${lon})`);
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new Error(`geohash: precision must be an integer 1..12, got ${precision}`);
  }
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true; // even bit index encodes longitude, odd encodes latitude
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch |= (1 << (4 - bit)); lonMin = mid; } else { lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch |= (1 << (4 - bit)); latMin = mid; } else { latMax = mid; }
    }
    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/**
 * The precision ladder for a fixed-location service. Emitting several
 * precisions (each a prefix of the longest) lets a client match at the
 * coarseness it needs: `#g` is exact-match, so a coarse region query and a
 * fine point query are different `g` values and both must be present.
 *
 * [4, 6, 8] gives a ~39km cell, a ~1.2km cell and a ~19m cell.
 */
export function geohashesFor(lat: number, lon: number, precisions: number[] = [4, 6, 8]): string[] {
  const out: string[] = [];
  let longest = "";
  for (const p of precisions) {
    const g = encodeGeohash(lat, lon, p);
    // each longer precision must extend the previous shorter one (ONE point)
    if (longest && !g.startsWith(longest)) {
      throw new Error(`geohash precision ${p} ('${g}') does not extend '${longest}'`);
    }
    longest = g;
    out.push(g);
  }
  return out;
}
