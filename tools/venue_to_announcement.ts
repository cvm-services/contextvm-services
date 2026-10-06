/**
 * venue_to_announcement.ts — map a `venue.json` record to the kit's
 * `AnnounceInput`, plus the kind-specific content JSON.
 *
 * This is the S4a glue: the venue adapter (S1a/S1b) produced `venue.json`; this
 * module turns that record into the discoverable CEP-6 surface. The tier is
 * NEVER supplied here — the vendored emitter recomputes `cvm:tier:<max>` from
 * the declared `cvm:req:*`/`cvm:opt:*` fields (docs/spec/service-inputs.md,
 * "the tier tag"). The CLI asserts the emitted tag equals the recomputed value.
 *
 * FLOW (declared honestly, rule 1 of the register): the venue's own ordering
 * deep-link asks the user for their delivery address and phone (both venues
 * offer delivery), so `ship.address` and `contact.phone` are REQUIRED by the
 * flow even though the CVM tool itself is a zero-argument deep-link. We do NOT
 * declare `cvm:req:none` — the venue page collects contact data.
 */

import {
  type AnnounceInput,
  type ToolCap,
  type Vocab,
} from "../vendor/cvm-service-kit/src/mod.ts";
import { geohashesFor } from "./geohash.ts";

/** A `venue.json` record as produced by the S1 adapters (schema `cvm.venue/v1`). */
export interface VenueRecord {
  slug: string;
  schema?: string;
  venue: {
    name?: string;
    type?: string;
    currency?: string;
    phone?: string;
    website?: string;
    address?: {
      lat?: number;
      lon?: number;
      city?: string;
      country?: string;
      street?: string;
      postal_code?: string;
      [k: string]: unknown;
    };
    ordering?: {
      primary_url?: string;
      urls?: Record<string, string | object>;
      note?: string;
    };
    dietary_attributes?: string[];
    order_methods?: string[];
    [k: string]: unknown;
  };
  menu?: {
    currency?: string;
    items?: Array<{ price?: number; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Human-meaningful plain `t` words, keyed by venue slug. Factual + curated. */
const CUISINE_TAGS: Record<string, string[]> = {
  "doppelt-kaese-berlin": ["burgers"],
  "pizza-e-pasta-ruedesheimerplatz": ["pizza", "pasta", "italian"],
};

/**
 * The fields the venue's own flow collects. Both venues offer delivery, so the
 * deep-link asks for a delivery address (fulfilment) and a phone (contact).
 * A name is requested for the order but is not strictly gating (optional).
 */
const REQUIRED_FIELDS = ["ship.address", "contact.phone"];
const OPTIONAL_FIELDS = ["contact.name", "order.notes"];

export interface VenueAnnouncement {
  input: AnnounceInput;
  content: unknown;
  /** the deep-link carried as `r` (the venue's own ordering rail) */
  deepLink: string;
  humanTags: string[];
}

/** The single v1 tool: place an order via the venue's own rail (deep-link). */
function buildTools(): Record<string, ToolCap> {
  // v1: the CVM itself settles nothing — the venue's own rail settles (ADR-0001
  // D5). The tool is a zero-cost deep-link, so its cap is 0 sats.
  return { order: { amount: 0, unit: "sats" } };
}

/** The one factual line both the content and the `about` tag carry (P3: one source). */
export function aboutLine(name: string): string {
  return `${name} — restaurant in Berlin, announced over ContextVM (CEP-6). ` +
    `Order via the venue's own rail; the deep-link asks for a delivery address and phone.`;
}

/**
 * The S5a §6 payload tags (D2): the multi-letter tags the registry reads for
 * display — `name`, `about`, `website` — which the kit neither emits nor
 * validates, so the publisher appends them verbatim.
 *
 * This is not cosmetic. The dashboard renders `e.name ?? e.d`
 * (cvm-registry site/app.js) and the collector fills `name` from the `name` TAG
 * (`tagValues(e.tags, "name")`), never from the content. Without these tags the
 * card falls back to the bare slug (`doppelt-kaese-berlin`). The nosms reference
 * appends its own PAYLOAD_TAGS for exactly this reason.
 */
export function venuePayloadTags(v: VenueRecord): string[][] {
  const name = v.venue?.name ?? v.slug;
  const website = v.venue?.website ?? v.venue?.ordering?.primary_url;
  const tags: string[][] = [
    ["name", name],
    ["about", aboutLine(name)],
  ];
  // Never claim a link we do not have: an absent website must not reach the
  // registry as the literal string "undefined" in a tag it renders as an anchor.
  if (website) tags.push(["website", website]);
  return tags;
}

/**
 * The wire tag set: the kit's contract tags, then the S5a §6 payload tags.
 *
 * The CLI and the tests both build the published set through here, so the set
 * the tests assert on cannot drift from the set that goes on the wire.
 */
export function venueWireTags(emittedTags: string[][], v: VenueRecord): string[][] {
  return [...emittedTags, ...venuePayloadTags(v)];
}

export function venueToAnnouncement(v: VenueRecord): VenueAnnouncement {
  const name = v.venue?.name ?? v.slug;
  const currency = v.venue?.currency ?? v.menu?.currency ?? "EUR";
  const lat = v.venue?.address?.lat;
  const lon = v.venue?.address?.lon;
  if (lat === undefined || lon === undefined) {
    throw new Error(`venue '${v.slug}' has no address.lat/address.lon`);
  }
  const deepLink = v.venue?.ordering?.primary_url ?? v.venue?.website;
  if (!deepLink) {
    throw new Error(`venue '${v.slug}' has no ordering.primary_url`);
  }

  const humanTags = ["berlin", ...(CUISINE_TAGS[v.slug] ?? [])];

  const input: AnnounceInput = {
    serviceClass: "restaurant",
    d: v.slug,
    geohashes: geohashesFor(lat, lon),
    required: REQUIRED_FIELDS,
    optional: OPTIONAL_FIELDS,
    tools: buildTools(),
    urls: [deepLink],
    humanTags,
  };

  // Menu summary only — the full menu lives on the venue's own rail; the
  // announcement must not become a 200KB menu dump (P3: generated from the
  // same source, i.e. this venue.json, but the catalogue is the rail's job).
  const items = v.menu?.items ?? [];
  const priced = items.filter((i) => typeof i?.price === "number" && Number.isFinite(i.price));
  const prices = priced.map((i) => i.price as number);
  const menuSummary = {
    item_count: items.length,
    priced_count: prices.length,
    currency,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
  };

  const content = {
    name,
    about: aboutLine(name),
    schema: "cvm.venue/v1",
    currency,
    area: {
      city: v.venue?.address?.city ?? null,
      country: v.venue?.address?.country ?? null,
    },
    location: { lat, lon },
    menu: menuSummary,
    ordering: {
      primary_url: deepLink,
      order_methods: v.venue?.order_methods ?? [],
    },
    tools: [
      {
        name: "order",
        description: `Place an order at ${name} via the venue's own ordering rail (deep-link).`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    settlement: "venue-rail (ADR-0001 D5)",
  };

  return { input, content, deepLink, humanTags };
}
