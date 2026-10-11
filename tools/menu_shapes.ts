/**
 * menu_shapes.ts — the three shapes the `menu` reply's option data could take, built
 * once so tools/menu_size.ts (payload) and tools/menu_frame_size.ts (gift-wrapped
 * relay size) are measuring the SAME bytes. The two tools disagreeing is how a
 * "fits the cap" claim gets made about a payload nobody publishes.
 *
 *   served     — what the server actually answers with: groups once per venue, each
 *                item carrying the group ids it offers + its own price level (R6)
 *   ac1Literal — AC1 read literally, choices collapsed to ONE resolved price for the
 *                item (the client cannot see why a pizza extra costs more on a large)
 *   ac1Full    — AC1 read literally, every choice carrying its full served shape and
 *                the venue's whole catalogue copied into each item
 *
 * All measurements are COMPACT JSON, because that is what goes on the wire; a
 * pretty-printed comparison reports numbers no relay ever sees.
 */
import { handleToolCall, type Index, type MenuItem, type Venue } from "../services/restaurant-cvm/server.ts";
import { groupsForItem, priceForItem, priceKeyOf } from "./venue_option_groups.ts";

export const compact = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export interface MenuShapes {
  /** Exactly the bytes handleToolCall("menu") returns as its text content. */
  served: string;
  /** The whole served payload for one venue only. */
  servedFor(venueSlug: string): string;
  /** AC1 literal, one resolved price per choice. */
  ac1Literal: unknown;
  /** AC1 literal, full served choice shape per item. */
  ac1Full: unknown;
  /** Per-venue component sizes, for attributing where the bytes go. */
  perVenue: { slug: string; items: number; catalogueGroups: number; idsOnly: number; catalogue: number; ac1Literal: number; ac1Full: number }[];
}

export function buildMenuShapes(index: Index, venues: Venue[]): MenuShapes {
  const served = handleToolCall(index, "menu", {}).content[0].text;

  const ac1Literal = {
    venues: venues.map((v) => ({
      ...v,
      items: v.items.map((it) => ({
        ...it,
        option_groups: groupsForItem(it.option_group_ids, v.option_groups).map((g) => ({
          id: g.id,
          name: g.name,
          required: g.required,
          multi_select: g.multi_select,
          min_count: g.min_count,
          max_count: g.max_count,
          choices: g.choices.map((c) => ({
            id: c.id,
            name: c.name,
            available: c.available,
            price: priceForItem(c, priceKeyOf(it.price_level_used ?? "")),
          })),
        })),
      })),
    })),
  };

  const ac1Full = {
    venues: venues.map((v) => ({
      ...v,
      items: v.items.map((it) => ({
        ...it,
        option_groups: groupsForItem(it.option_group_ids, v.option_groups),
      })),
    })),
  };

  const perVenue = venues.map((v) => {
    const idsOnly = { ...v, option_groups: [], items: v.items.map((it) => ({ ...it, option_groups: [] })) };
    return {
      slug: v.slug,
      items: v.items.length,
      catalogueGroups: v.option_groups.length,
      idsOnly: compact(idsOnly),
      catalogue: compact({ ...v, items: v.items.map((it) => ({ ...it, option_groups: [] })) }),
      ac1Literal: compact((ac1Literal.venues.find((x) => x.slug === v.slug) as Venue)),
      ac1Full: compact((ac1Full.venues.find((x) => x.slug === v.slug) as Venue)),
    };
  });

  return {
    served,
    servedFor: (slug: string) => handleToolCall(index, "menu", { venue_slug: slug }).content[0].text,
    ac1Literal,
    ac1Full,
    perVenue,
  };
}
