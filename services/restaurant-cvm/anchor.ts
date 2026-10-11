// anchor.ts — the COMMITTED verification anchor for the served menu contract.
//
// WHY THIS EXISTS (independent verification, card t_a640b7ca review)
// ------------------------------------------------------------------
// The first version of the Steglitz onboarding verified the served menu by
// DERIVING the expectation from the very records the server serves:
// `e2e_client.ts` built `expectTotal` from `loadVenues()`, and `server_test.ts`
// re-walked `venues/` and re-ran the server's own `validateAdapter()`. Both
// sides computed the same expression over the same files, so ANY record passed:
// a fabricated `venues/<slug>/venue.json` (no evidence, no adapter.py, no
// source, invented prices) was served and every check stayed green. An
// expectation derived from the artefact under test cannot fail on a bad
// artefact.
//
// The fix is an anchor that is COMMITTED and not recomputed from `venues/` at
// test time:
//
//   venues/anchors.json   the expected served contract, per venue:
//                         item count, price bounds, priced methods, the count of
//                         "from" (starting) prices, the capture time, and a
//                         sha256 over the venue's whole served projection.
//
//   deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write
//
// regenerates it. Regeneration is the review gate: onboarding a venue or
// re-capturing one is a VISIBLE diff to `venues/anchors.json`, and nothing else
// in the tree can make a new or edited record pass quietly. Three separate
// checks then hold:
//
//   1. the anchor matches the venue records  (drift guard — a record edit
//      without a regeneration fails);
//   2. the LIVE served reply matches the anchor (independence — the reply is
//      never compared against a value recomputed at test time);
//   3. every served venue was built from committed evidence on disk
//      (`evidence/raw/source.json` for the capture tool), so a hand-typed
//      record with no evidence fails even if the anchor is regenerated.
//
// The anchor is DATA, not code: onboarding a venue still touches zero code files
// (add `venues/<slug>/` + its evidence, then regenerate this file).

import {
  type ServedVenue,
  servedVenueProjection,
  type Venue,
} from "./server.ts";

export const ANCHOR_URL = new URL("../../venues/anchors.json", import.meta.url);
export const VENUES_DIR_URL = new URL("../../venues/", import.meta.url);
export const ANCHOR_SCHEMA = "venue-menu-anchor/1";

/** The expected served contract of ONE venue. */
export interface VenueAnchor {
  item_count: number;
  from_priced_count: number;
  priced_methods: string[];
  min_price: number | null;
  max_price: number | null;
  captured_at: string | null;
  menu_sha256: string;
}

export interface Anchor {
  schema: string;
  generated_by: string;
  note: string;
  regenerate: string;
  served_venues: string[];
  total_items: number;
  /** sha256 over `{ total_items, venues }` as served — the whole catalogue. */
  menu_sha256: string;
  venues: Record<string, VenueAnchor>;
}

/**
 * Deterministic JSON: object keys sorted at every depth, 2-space indent. Two
 * runs over equal data produce equal bytes, so a hash of this text is stable
 * across a rewrite of the same record (venues/README.md rule 3).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact bytes of `venues/anchors.json` for a given anchor. */
export function anchorFileText(anchor: Anchor): string {
  return canonicalJson(anchor) + "\n";
}

/** The text that is hashed: the served reply's catalogue, nothing else. */
export function servedCatalogueText(projections: ServedVenue[], totalItems: number): string {
  return canonicalJson({ total_items: totalItems, venues: projections });
}

/** Build the anchor for a served venue set (pure over the loaded venues). */
export async function buildAnchor(venues: Venue[]): Promise<Anchor> {
  const sorted = [...venues].sort((a, b) => a.slug.localeCompare(b.slug));
  const projections: ServedVenue[] = [];
  const perVenue: Record<string, VenueAnchor> = {};
  let totalItems = 0;

  for (const venue of sorted) {
    const projection = servedVenueProjection(venue);
    projections.push(projection);
    totalItems += projection.item_count;
    perVenue[venue.slug] = {
      item_count: projection.item_count,
      from_priced_count: projection.from_priced_count,
      priced_methods: projection.priced_methods,
      min_price: projection.min_price,
      max_price: projection.max_price,
      captured_at: projection.captured_at,
      menu_sha256: await sha256Hex(canonicalJson(projection)),
    };
  }

  return {
    schema: ANCHOR_SCHEMA,
    generated_by: "venues/tools/menu_anchors.ts",
    note:
      "Committed expectation for the SERVED menu contract. The tests and the e2e client " +
      "compare the LIVE reply against this file; `venues/` is compared against it " +
      "separately as a drift guard. A change here is the visible review gate for " +
      "onboarding or re-capturing a venue (data, never code).",
    regenerate: "deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write",
    served_venues: sorted.map((v) => v.slug),
    total_items: totalItems,
    menu_sha256: await sha256Hex(servedCatalogueText(projections, totalItems)),
    venues: perVenue,
  };
}

/** Read the committed anchor, refusing a missing/malformed one loudly. */
export async function readAnchor(): Promise<Anchor> {
  let raw: Anchor;
  try {
    raw = JSON.parse(await Deno.readTextFile(ANCHOR_URL)) as Anchor;
  } catch (err) {
    throw new Error(
      `no committed verification anchor at venues/anchors.json (${(err as Error).message}); ` +
        `generate it with: deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write`,
    );
  }
  if (raw?.schema !== ANCHOR_SCHEMA) {
    throw new Error(`venues/anchors.json has schema ${JSON.stringify(raw?.schema)}, expected ${ANCHOR_SCHEMA}`);
  }
  for (const field of ["served_venues", "total_items", "menu_sha256", "venues"] as const) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`venues/anchors.json is missing '${field}'`);
    }
  }
  if (!Array.isArray(raw.served_venues) || raw.served_venues.length === 0) {
    throw new Error("venues/anchors.json declares no served venues");
  }
  return raw;
}


/**
 * The committed evidence a served venue MUST have been built from.
 *
 * Returns the problem, or null when the evidence is intact. A venue that is
 * served without evidence on disk is a hand-typed record: the reviewer's
 * fabricated `venues/<slug>/venue.json` (no evidence, no adapter.py, no source,
 * invented prices) passed every check the first version had, because every
 * check re-derived its expectation from that same file. This is the check that
 * cannot be satisfied by typing a record: the bytes have to be there.
 */
export async function evidenceProblem(
  slug: string,
  raw: Record<string, unknown>,
): Promise<string | null> {
  const dir = new URL(`${slug}/evidence/`, VENUES_DIR_URL);
  let entries: string[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
  } catch {
    return `no evidence/ directory at venues/${slug}/evidence/: a served venue must be built from committed evidence`;
  }
  if (entries.length === 0) {
    return `venues/${slug}/evidence/ is empty: a served venue must be built from committed evidence`;
  }

  const menu = (raw.menu ?? {}) as Record<string, unknown>;
  if (menu.generated_by !== "venues/tools/capture_menu.py") return null; // per-venue adapter.py: its own --check

  // The shared capture tool writes evidence/raw/source.json and hashes the RAW
  // response. The record must be rebuildable from those bytes: --check proves
  // the menu block and the sha256 both come from them.
  const source = (menu.source ?? {}) as Record<string, unknown>;
  let committed: Record<string, unknown>;
  try {
    committed = JSON.parse(
      await Deno.readTextFile(new URL(`${slug}/evidence/raw/source.json`, VENUES_DIR_URL)),
    ) as Record<string, unknown>;
  } catch {
    return `venues/${slug}/evidence/raw/source.json is missing or unreadable: the record cannot be rebuilt from evidence`;
  }
  if (committed.sha256_response !== source.sha256_response) {
    return `venues/${slug}: evidence/raw/source.json sha256_response (${committed.sha256_response}) != menu.source.sha256_response (${source.sha256_response})`;
  }
  if (committed.captured_at !== menu.captured_at) {
    return `venues/${slug}: evidence/raw/source.json captured_at (${committed.captured_at}) != menu.captured_at (${menu.captured_at})`;
  }
  let pageBytes = 0;
  try {
    pageBytes = (await Deno.readTextFile(new URL(`${slug}/evidence/raw/page.txt`, VENUES_DIR_URL))).length;
  } catch {
    return `venues/${slug}/evidence/raw/page.txt is missing: there is nothing to rebuild the menu from`;
  }
  if (pageBytes === 0) return `venues/${slug}/evidence/raw/page.txt is empty`;
  let fragments = 0;
  try {
    for await (const entry of Deno.readDir(new URL(`${slug}/evidence/fragments/`, VENUES_DIR_URL))) {
      if (entry.isFile && entry.name.endsWith(".txt")) fragments += 1;
    }
  } catch {
    return `venues/${slug}/evidence/fragments/ is missing (venues/README.md requires the readable byte-slices)`;
  }
  if (fragments === 0) return `venues/${slug}/evidence/fragments/ holds no fragment`;
  return null;
}

/** The raw venue record behind a slug, as committed. */
export async function readVenueRaw(slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(new URL(`${slug}/venue.json`, VENUES_DIR_URL)),
  ) as Record<string, unknown>;
}
