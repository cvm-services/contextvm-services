/**
 * review_event.ts — the review event shape. Pure: no I/O, no signing.
 *
 * A review is a customer's own signed statement about a venue that announced
 * itself with CEP-6 (see docs/spec/cep-draft-0001-provider.md). The shape is
 * pinned in docs/adr/0002-reviews-event-shape.md; read that first.
 *
 * WHY THIS KIND AND NOT 11318–11320
 * ----------------------------------
 * The provider spec reserves 11316/11317 for announcements and allows
 * 11318–11320. Every one of those sits in NIP-16's *replaceable* range
 * (10000 ≤ kind < 20000), which relays key by `(kind, pubkey)` alone. For
 * announcements that is merely awkward (it is why each venue needs its own
 * key). For reviews it is fatal: one author could hold exactly ONE review
 * across the entire network, every new review silently overwriting the last.
 *
 * So reviews use the *addressable* range (30000 ≤ kind < 40000), keyed by
 * `(kind, pubkey, d)`. With `d` = venue slug that gives exactly the wanted
 * semantics: one editable review per reviewer per venue, and different
 * reviewers never collide because the pubkey differs.
 *
 * FILTERABILITY (spec P2: "MUST NOT rely on a multi-letter tag for anything a
 * client is expected to filter on")
 * --------------------------------------------------------------------------
 * Single-letter tags only are indexed, so:
 *   - the rating is filterable via `t` = `cvm:rating:<n>` (and `l`/`L` per
 *     NIP-32 for label-aware clients)
 *   - the human-readable `["rating","4","5"]` tag is PAYLOAD ONLY. It is
 *     convenient, it is NOT a filter contract, and nothing may rely on it.
 */

/** Addressable (30000–39999): see the header. Reserving a number is a spec
 *  amendment — ADR-0002 records that this needs the spec owner's ack. */
export const REVIEW_KIND = 30316;

/** The announcement family this review binds to. */
export const ANNOUNCE_TOOLS_KIND = 11317;

/** The range relays treat as replaceable — a kind in here cannot back reviews. */
export const REPLACEABLE_RANGE: readonly [number, number] = [10000, 20000];

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export interface ReviewInput {
  /** Venue slug — must equal the announcement's `d`. */
  venue_slug: string;
  /** Provider npub/pubkey hex the announcement was signed with. */
  provider_pubkey: string;
  /** The venue's own ordering/docs URL; must equal the announcement's `r`. */
  venue_url: string;
  /** 1..5 inclusive. */
  rating: number;
  /** Geohashes of the venue, at least one (spec P2 requires `g` for places). */
  geohashes: string[];
  /** The reviewer's free text. */
  content: string;
  /** Optional: the exact announcement event id being reviewed. */
  announcement_event_id?: string;
  /** Unix seconds; defaults at emit time, never in the builder (determinism). */
  created_at: number;
}

export interface ReviewTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("review: " + msg);
}

/** The `a` coordinate that ties a review to one announced service. */
export function announcementCoordinate(providerPubkey: string, venueSlug: string): string {
  return `${ANNOUNCE_TOOLS_KIND}:${providerPubkey}:${venueSlug}`;
}

/**
 * The guard that keeps someone from "tidying" reviews into the announcement
 * family. Exported so a test can prove it actually rejects 11318–11320.
 */
export function assertNotReplaceable(kind: number): void {
  if (kind >= REPLACEABLE_RANGE[0] && kind < REPLACEABLE_RANGE[1]) {
    throw new Error(
      `review: kind ${kind} is in the replaceable range ${REPLACEABLE_RANGE[0]}–` +
        `${REPLACEABLE_RANGE[1] - 1} (NIP-16): relays key those by (kind, pubkey) alone, so every ` +
        `review by one author would overwrite the last. Use the addressable range (30000–39999).`,
    );
  }
}

export function buildReviewEvent(input: ReviewInput): ReviewTemplate {
  const {
    venue_slug, provider_pubkey, venue_url, rating, geohashes, content,
    announcement_event_id, created_at,
  } = input;

  assert(SLUG.test(venue_slug), `venue_slug '${venue_slug}' is not a kebab slug`);
  assert(HEX64.test(provider_pubkey), "provider_pubkey must be 64-char lowercase hex");
  assert(
    venue_url.startsWith("http://") || venue_url.startsWith("https://"),
    `venue_url '${venue_url}' is not absolute http(s)`,
  );
  assert(
    Number.isInteger(rating) && rating >= RATING_MIN && rating <= RATING_MAX,
    `rating must be an integer in ${RATING_MIN}..${RATING_MAX}, got ${rating}`,
  );
  assert(content.trim().length > 0, "content must not be empty");
  assert(Number.isInteger(created_at) && created_at > 0, "created_at must be unix seconds");
  assert(Array.isArray(geohashes) && geohashes.length > 0, "at least one geohash is required");
  for (const g of geohashes) {
    assert(typeof g === "string" && g.length >= 2 && /^[0-9b-hj-km-np-z]+$/.test(g), `bad geohash '${g}'`);
  }
  if (announcement_event_id !== undefined) {
    assert(HEX64.test(announcement_event_id), "announcement_event_id must be 64-char hex");
  }
  assertNotReplaceable(REVIEW_KIND);

  const tags: string[][] = [
    ["d", venue_slug],
    ["a", announcementCoordinate(provider_pubkey, venue_slug)],
    ["p", provider_pubkey],
    ["r", venue_url],
    ["t", "cvm:review"],
    ["t", `cvm:rating:${rating}`],
    ["L", "cvm.rating"],
    ["l", String(rating), "cvm.rating"],
    ["rating", String(rating), String(RATING_MAX)],
    ...geohashes.map((g) => ["g", g]),
  ];
  if (announcement_event_id) tags.push(["e", announcement_event_id, "", "announcement"]);

  return { kind: REVIEW_KIND, created_at, tags, content: content.trim() };
}

/** Stable fingerprint used by tests and by the collector's dedupe. */
export function reviewCoordinate(providerPubkey: string, venueSlug: string, reviewerPubkey: string): string {
  return `${REVIEW_KIND}:${reviewerPubkey}:${venueSlug}`;
}
