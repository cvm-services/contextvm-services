/**
 * attestation_event.ts — a venue vouching for a reviewer. Pure, no I/O.
 *
 * READ THIS BEFORE TRUSTING THE BADGE
 * -----------------------------------
 * A venue-signed attestation says: "this venue confirms reviewer X ordered from
 * it." It is signed by the venue's OWN key — the same npub that signed the
 * announcement — which is the whole security property: a third party cannot mint
 * a confirmation for a venue it does not control.
 *
 * It does NOT prove the reviewer was physically present. The venue could vouch
 * for anyone, sell confirmations, or be mistaken. So the badge in the UI says
 * "venue-confirmed" and never "verified visit" or "proof of place". The stronger
 * claim — membership in a "customers who visited" set without revealing which
 * member — is the LSAG ring tier (R4b), which is NOT implemented here and must
 * not be faked by this badge.
 *
 * Shape: addressable (30000-39999, same reasoning as reviews: the 10000-19999
 * range is NIP-16 replaceable and would collapse a venue to ONE attestation
 * network-wide), keyed by `d` = "<venue_slug>:<reviewer_pubkey>". One venue, many
 * attestations, no collisions; revoking means republishing or deleting.
 */

import type { ReviewTemplate } from "./review_event.ts";

/** Addressable: see the header. Reserving a number is a spec amendment. */
export const ATTESTATION_KIND = 30317;

export const ATTESTATION_CLASS = "cvm:attestation";
export const ATTESTATION_TYPE_VENUE_SIGNED = "cvm:attestation:venue-signed";

/** The range relays treat as replaceable — unusable for one-per-reviewer data. */
export const REPLACEABLE_RANGE: readonly [number, number] = [10000, 20000];

export interface AttestationInput {
  /** Venue slug — must equal the announcement's `d`. */
  venue_slug: string;
  /** The REVIEWER being vouched for. */
  reviewer_pubkey: string;
  /** The venue's own npub/pubkey — the attestation is signed by this key. */
  provider_pubkey: string;
  /** Optional: the exact review event this attestation is about. */
  review_event_id?: string;
  /** What the venue is actually claiming. Kept explicit and narrow. */
  claim: string;
  created_at: number;
}

export interface AttestationTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("attestation: " + msg);
}

/** The addressable identity: one attestation per venue per reviewer. */
export function attestationD(venueSlug: string, reviewerPubkey: string): string {
  return `${venueSlug}:${reviewerPubkey}`;
}

export function announcementCoordinate(providerPubkey: string, venueSlug: string): string {
  return `11317:${providerPubkey}:${venueSlug}`;
}

export function assertNotReplaceable(kind: number): void {
  if (kind >= REPLACEABLE_RANGE[0] && kind < REPLACEABLE_RANGE[1]) {
    throw new Error(
      `attestation: kind ${kind} is replaceable (NIP-16, keyed by kind+pubkey) — a venue ` +
        `could hold only ONE attestation, so its second vouch would erase the first`,
    );
  }
}

export function buildAttestation(input: AttestationInput): AttestationTemplate {
  const { venue_slug, reviewer_pubkey, provider_pubkey, review_event_id, claim, created_at } = input;

  assert(SLUG.test(venue_slug), `venue_slug '${venue_slug}' is not a kebab slug`);
  assert(HEX64.test(reviewer_pubkey), "reviewer_pubkey must be 64-char lowercase hex");
  assert(HEX64.test(provider_pubkey), "provider_pubkey must be 64-char lowercase hex");
  assert(
    reviewer_pubkey !== provider_pubkey,
    "a venue cannot attest for itself as the reviewer",
  );
  assert(claim.trim().length > 0, "claim must not be empty");
  assert(Number.isInteger(created_at) && created_at > 0, "created_at must be unix seconds");
  if (review_event_id !== undefined) {
    assert(HEX64.test(review_event_id), "review_event_id must be 64-char hex");
  }
  assertNotReplaceable(ATTESTATION_KIND);

  const tags: string[][] = [
    ["d", attestationD(venue_slug, reviewer_pubkey)],
    ["a", announcementCoordinate(provider_pubkey, venue_slug)],
    ["p", reviewer_pubkey],
    ["t", ATTESTATION_CLASS],
    ["t", ATTESTATION_TYPE_VENUE_SIGNED],
  ];
  if (review_event_id) tags.push(["e", review_event_id, "", "review"]);

  return { kind: ATTESTATION_KIND, created_at, tags, content: claim.trim() };
}
