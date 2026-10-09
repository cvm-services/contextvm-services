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

import { type AnnounceInput, type ToolCap, type Vocab } from "../vendor/cvm-service-kit/src/mod.ts";
import { geohashesFor } from "./geohash.ts";
import { normaliseOptionCatalogue } from "./venue_option_groups.ts";

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
    /** the adapter's own availability facts, not just the summary method list */
    pickup?: { available?: boolean; estimated_minutes?: number; [k: string]: unknown };
    delivery?: { available?: boolean; [k: string]: unknown };
    /** what the venue itself accepts — recorded or explicitly absent, never guessed */
    settlement?: SettlementFacts | null;
    [k: string]: unknown;
  };
  menu?: {
    currency?: string;
    items?: Array<{
      price?: number;
      /** per-fulfilment-method price columns (delivery/pickup/dine_in/…) */
      prices_by_order_method?: Record<string, number>;
      service_method?: string;
      [k: string]: unknown;
    }>;
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
 * The fulfilment methods the venue actually offers: the adapter's summary list,
 * plus anything its own `pickup`/`delivery` availability flags claim that the
 * summary missed. Only the three methods the register names are legal here.
 */
export function fulfilmentMethods(v: VenueRecord): string[] {
  const out: string[] = [];
  for (const m of v.venue?.order_methods ?? []) {
    if ((m === "pickup" || m === "delivery" || m === "dine_in") && !out.includes(m)) out.push(m);
  }
  if (!out.includes("pickup") && v.venue?.pickup?.available === true) out.push("pickup");
  if (!out.includes("delivery") && v.venue?.delivery?.available === true) out.push("delivery");
  return out;
}

/**
 * The fields the venue's own flow requires — decided PER VENUE, because the
 * honest answer depends on which methods it offers.
 *
 * `order.fulfilment` is required: the customer must choose pickup or delivery,
 * and that choice decides whether an address is needed at all (and, at these
 * venues, which price column applies).
 *
 * `ship.address` is required only when the venue delivers and can do nothing
 * else. Declaring it for a venue that also does pickup is a false claim about the
 * appetite — register rule 2 forbids it, and it tells every pickup customer they
 * must hand over an address they never need. (Fixed 2026-10-06: both venues here
 * offer pickup, and both announcements claimed a required address.)
 *
 * `contact.phone` stays required: both venues' rails ask for a number to reach
 * the customer — a driver or the counter calling the order.
 *
 * The register is a flat AND list, so "address, but only when delivery" cannot be
 * expressed in tags. The honest encoding is an optional field plus the condition
 * written out in the content's `fulfilment.method_condition`.
 */
type SettlementFacts = {
  rail?: string;
  currency?: string;
  tax?: string;
  cvm_cap?: number | null;
  [k: string]: unknown;
};

/**
/**
 * The venue's own settlement block, as the adapter recorded it from the venue's
 * own storefront. Nullable on purpose: when nothing was recorded we say so rather
 * than name a rail the user would go on to rely on.
 */
export function settlementOf(v: VenueRecord): SettlementFacts | null {
  const s = v.venue?.settlement;
  return s && typeof s === "object" ? s : null;
}

/** Required: fulfilment is the choice; an address only when the venue only delivers. */
export function requiredFields(v: VenueRecord): string[] {
  const methods = fulfilmentMethods(v);
  const deliveryOnly = methods.includes("delivery") && !methods.includes("pickup");
  return deliveryOnly
    ? ["order.items", "order.fulfilment", "order.when", "ship.address", "contact.phone"]
    : ["order.items", "order.fulfilment", "order.when", "contact.phone"];
}

/** Accepted but not required: the address is here because delivery may be chosen. */
export function optionalFields(v: VenueRecord): string[] {
  const methods = fulfilmentMethods(v);
  const deliveryOnly = methods.includes("delivery") && !methods.includes("pickup");
  return deliveryOnly
    ? ["contact.name", "order.notes"]
    : ["ship.address", "contact.name", "order.notes"];
}

/**
 * "Meatspace": the goods change hands in person — a physical fulfilment method
 * (pickup / dine_in) is declared AND no postal address is required.
 *
 * Deliberately NOT derived from "requires no shipping address" alone: every
 * digital service requires no address either, and classing those as walk-in
 * shops would be a false claim on exactly the facet a buyer would use to find
 * somewhere they can physically go.
 */
export function isMeatspace(v: VenueRecord): boolean {
  if (requiredFields(v).some((f) => f.startsWith("ship."))) return false;
  const methods = fulfilmentMethods(v);
  return methods.includes("pickup") || methods.includes("dine_in");
}

export interface VenueAnnouncement {
  input: AnnounceInput;
  content: unknown;
  /** the deep-link carried as `r` (the venue's own ordering rail) */
  deepLink: string;
  humanTags: string[];
}

/**
 * The Stage-1 order tool schema: basket + fulfilment + when + optional notes/ship/contact.
 *
 * This is the schema the announcement PUBLISHES, i.e. the interface a client reads before
 * it calls anything. `services/restaurant-cvm/server.ts` carries the schema the server
 * ANSWERS with, and server_test.ts asserts the two are byte-identical: on 2026-10-06 they
 * had drifted, the published copy still demanding `{sku, qty}` while the server had begun
 * refusing colliding skus in favour of the venue item id — so the published interface hid
 * the only way to order pizza's sku 36/110/44.
 */
function buildOrderTool(
  name: string,
): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: "order",
    description:
      `Build a basket for ${name} on the venue's own ordering rail. Checkout and payment happen on the venue's own page; this tool does not place or settle the order.`,
    inputSchema: {
      type: "object",
      properties: {
        venue_slug: {
          type: "string",
          description: "The venue to order from.",
        },
        items: {
          type: "array",
          description:
            "Basket lines. Identify each item by `sku` or by the venue's `id` — exactly one. A sku matching more than one item (pizza: 36, 110, 44) is refused; pass `id` there.",
          items: {
            type: "object",
            properties: {
              sku: {
                type: "string",
                description:
                  "Venue sku. Refused when it identifies more than one item — use `id` instead.",
              },
              id: {
                type: "string",
                description: "The venue's own item id, unique where a sku is not.",
              },
              qty: { type: "integer", minimum: 1 },
              options: {
                type: "object",
                description:
                  "Chosen options, keyed by option group id, values are arrays of choice ids drawn from that group in this item's own groups (see the `menu` tool). A required group must be present; a choice not in the item's groups, over the group's limit, or unavailable is refused naming it.",
                additionalProperties: { type: "array", items: { type: "string" } },
              },
            },
            required: ["qty"],
            additionalProperties: false,
          },
        },
        fulfilment: {
          type: "string",
          enum: ["pickup", "delivery", "dine_in"],
          description: "How the order will be fulfilled.",
        },
        when: {
          type: "string",
          description: "Requested fulfilment time (ISO 8601 or 'asap').",
        },
        notes: {
          type: "string",
          description: "Free text for the kitchen/handler.",
        },
        ship: {
          type: "object",
          description: "Required only when fulfilment == 'delivery'.",
          properties: {
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
                postal_code: { type: "string" },
                country: { type: "string" },
              },
            },
            recipient_name: { type: "string" },
            notes: { type: "string" },
          },
        },
        contact: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
          },
        },
      },
      required: ["venue_slug", "items", "fulfilment", "when"],
      additionalProperties: false,
    },
  };
}

/** The single v1 tool: build a basket for the venue's own rail (deep-link). */
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
  const methods = fulfilmentMethods(v);
  const deliveryOnly = methods.includes("delivery") && !methods.includes("pickup");

  const input: AnnounceInput = {
    serviceClass: "restaurant",
    d: v.slug,
    extraClasses: isMeatspace(v) ? ["meatspace"] : [],
    geohashes: geohashesFor(lat, lon),
    required: requiredFields(v),
    optional: optionalFields(v),
    tools: buildTools(),
    urls: [deepLink],
    humanTags,
  };

  // Menu summary only — the full menu lives on the venue's own rail; the
  // announcement must not become a 200KB menu dump (P3: generated from the
  // same source, i.e. this venue.json, but the catalogue is the rail's job).
  const items = v.menu?.items ?? [];
  const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const prices = items.filter((i) => numeric(i?.price)).map((i) => i.price as number);
  // What you pay depends on the fulfilment method: 72 of 76 doppelt items are
  // cheaper on pickup (Cheeseburger 8.90 pickup vs 9.50 delivery). The item's own
  // `price` is one column of that table, so quoting min/max from it alone would
  // hand every pickup customer the delivery price. Publish the table as well.
  const byMethod: Record<string, number[]> = {};
  for (const i of items) {
    const cols = i?.prices_by_order_method;
    if (cols && typeof cols === "object") {
      for (const [m, p] of Object.entries(cols)) if (numeric(p)) (byMethod[m] ??= []).push(p);
    } else if (typeof i?.service_method === "string" && numeric(i?.price)) {
      (byMethod[i.service_method] ??= []).push(i.price as number);
    }
  }
  const pricedMethods = Object.fromEntries(
    Object.entries(byMethod)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, ps]) => [m, {
        count: ps.length,
        currency,
        min_price: Math.min(...ps),
        max_price: Math.max(...ps),
      }]),
  );
  const menuSummary = {
    item_count: items.length,
    priced_count: prices.length,
    currency,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    prices_by_method: pricedMethods,
    price_basis: Object.keys(pricedMethods).length
      ? "min_price/max_price are the item's own price column; prices_by_method carries what each fulfilment method actually pays"
      : "min_price/max_price are the item's own price column (this venue publishes no per-method prices)",
  };

  // Options are announced as their SHAPE, never as a second price table. The
  // group -> choice -> price mapping is served data and only the `menu` tool has
  // the room to carry it (R6 measurement in tools/venue_option_groups.ts: the
  // catalogue form is 103 KB of menu JSON, and the announcement is a summary).
  // Both this block and the served catalogue are built by the SAME normaliser, so
  // a client reading "group 68406 takes up to 10 extras" here and the group it gets
  // from `menu` cannot disagree about the limit.
  const optionGroups = normaliseOptionCatalogue(v.menu ?? {});
  const itemsWithOptions = items.filter((i) =>
    Array.isArray(i?.option_group_ids) && i.option_group_ids.length > 0
  ).length;
  const optionsSummary = optionGroups.length
    ? {
      group_count: optionGroups.length,
      items_with_options: itemsWithOptions,
      price_level_dependent: optionGroups.some((g) => g.price_level_dependent),
      groups: optionGroups.map((g) => ({
        id: g.id,
        name: g.name,
        required: g.required,
        multi_select: g.multi_select,
        min_count: g.min_count,
        max_count: g.max_count,
        choice_count: g.choices.length,
      })),
      note: "shapes only: the choice list and each choice's price for an item's own " +
        "price level are served by the `menu` tool, read from the venue's numbers",
    }
    : null;

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
    menu: { ...menuSummary, options: optionsSummary },
    ordering: {
      primary_url: deepLink,
      order_methods: v.venue?.order_methods ?? [],
    },
    fulfilment: {
      methods,
      pickup: v.venue?.pickup ?? null,
      delivery: v.venue?.delivery
        ? {
          available: v.venue.delivery.available ?? null,
          areas_named: (v.venue.delivery as { areas_named?: string[] }).areas_named ?? null,
          areas_note: (v.venue.delivery as { area_note?: string }).area_note ?? null,
        }
        : null,
      // The register is a flat AND list and cannot say "address, but only when
      // delivery". So the condition is stated here, in words, for the reader.
      method_condition: deliveryOnly
        ? "ship.address is required: this venue delivers only."
        : "ship.address is required for a DELIVERY order only; a PICKUP order needs no address " +
          "(the venue's own page asks for the address when delivery is chosen).",
    },
    tools: [
      buildOrderTool(name),
    ],
    settlement: {
      settles: "venue's own rail (ADR-0001 D5): this CVM takes no payment",
      rail: settlementOf(v)?.rail ?? null,
      currency,
      tax: settlementOf(v)?.tax ?? null,
      cvm_cap_sats: settlementOf(v)?.cvm_cap ?? 0,
      recorded: settlementOf(v) !== null,
      note: settlementOf(v) === null
        ? "the adapter recorded no settlement block for this venue; the venue's own page shows what it accepts"
        : "rail as recorded from the venue's own storefront",
    },
  };

  return { input, content, deepLink, humanTags };
}
