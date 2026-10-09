/**
 * venue_option_groups.ts — the ONE model for `menu.option_groups`.
 *
 * Shared by the venue.json -> announcement adapter (`tools/venue_to_announcement.ts`)
 * and the served `menu` tool (`services/restaurant-cvm/server.ts`). One module
 * because the announced and the served surfaces already drifted once on the `order`
 * schema (PR #14) and options are the same hazard: two copies of a price rule is a
 * way to charge the wrong number.
 *
 * THE TWO VENUES DESCRIBE OPTIONS DIFFERENTLY (PLAN-0006 Track D):
 *   doppelt — flat, absolute:
 *     { id, name, required, max_count, multi_select, options: [{ id, name, price, available }] }
 *   pizza — level-dependent:
 *     { id, name, required, max, multi_select, price_level_dependent, type,
 *       options: [{ id, name, list_price, price_level1, price_level2, discounted_price, ... }] }
 * pizza's delta depends on THE ITEM'S OWN price level (`price_level_used`, e.g.
 * `size2`), and there are discounted variants.
 *
 * EVERY RULE BELOW IS MEASURED, NOT GUESSED. Each cites the venue data behind it
 * (venues/*\/venue.json, venues/doppelt-kaese-berlin/evidence/raw/menus.json, read
 * 2026-10-09).
 *
 * R1 — A PRICE IS A SERVED NUMBER, KEYED BY THE LEVEL IT IS FOR. Never computed.
 *      Each choice carries `prices`, keyed exactly as the venue published the
 *      column: `default` for its level-independent column, `1`/`2` for
 *      `price_level1`/`price_level2`. The order tool then READS, in this order:
 *        (a) the key the item's own `price_level_used` names;
 *        (b) else the venue's level-independent column, `default`;
 *        (c) else nothing — the choice publishes no price at all.
 *      Measured, because (b) is the difference between a working basket and a
 *      refused one, and an earlier, stricter reading ("no price for this level =>
 *      refuse") BROKE REAL DATA:
 *        - (b) applies to 6 pizza choices (58 raw) whose ONLY price is the flat
 *          column: the `PriceLevelEnum` "Deine Größe" rows, e.g. choice 43938710
 *          "Ø 32cm" `discountedPrice 9.0 / listPrice 10.0` with
 *          `price_level1/2: null`. That flat price IS the item's own price at the
 *          size it names — item 6943925 (size2) serves `price 11.7` and its size
 *          choice 43938809 carries exactly `discounted_price 11.7`. Refusing it
 *          would make 42 pizza items unorderable, since "Deine Größe" is
 *          `required: true` on every one of them.
 *        - Wherever the venue publishes BOTH, `1` equals `default`
 *          (group 4318512: `{1: 1.8, 2: 2.7, default: 1.8}`), so (b) is the same
 *          reading the venue itself uses, not a substitute number.
 *        - (c) is a real case, not an error: 5 pizza choices carry no price field
 *          at all. Raw venue row, verbatim: `{id: 43938692, orderBy: 0, title:
 *          "Hausdressing"}` in group 4454489 (`isRequired: true`, `type:
 *          "SelectOneEnum"`), and the dish's own description says "Alle Gerichte
 *          werden mit Dressing nach Wahl zubereitet" — the venue states the
 *          dressing is included and charges nothing for it. There is no number to
 *          read, so the delta is 0; the alternative was charging `default`
 *          (absent) as 0 anyway, silently.
 *      Measured over both venues: 1616 item+choice resolutions, 0 left without a
 *      number under (a)/(b)/(c). A choice the venue priced nowhere is never
 *      guessed at — see R1b below for where "no number" DOES refuse.
 *
 * R1b — A NUMBER THAT IS THERE BUT NOT USABLE STILL REFUSES. `prices` holds only
 *      columns the venue published numerically. If a choice's level key is absent
 *      AND its flat column is absent too, the choice has no published price at
 *      all — (c) — and the delta is 0 because the venue's own row says so. But a
 *      choice that is UNKNOWN, UNAVAILABLE, in the wrong group, over its group's
 *      limit, or in a `required` group that was left out is REFUSED by name. The
 *      order tool never drops a choice it did not understand.
 *
 * R2 — THE DISCOUNTED COLUMN WINS for a discounted venue: `discounted_price_level<N>`
 *      before `price_level<N>`, `discounted_price` (then `list_price`) before `price`.
 *      Measured: pizza item 6943925 serves `price: 11.7` with
 *      `price_levels.size2 = { list: 13.0, discounted: 11.7 }`. Charging the list
 *      column for its options while the item itself is discounted would overcharge
 *      every discounted item.
 *
 * R3 — A CHOICE IS A CHOICE ONLY IF IT HAS A NAME. doppelt group 69487 ("Passt gut
 *      dazu") carries 7 entries shaped `{ id, type: "product_ref" }` — cross-sell
 *      references to OTHER PRODUCTS (sku 331232 Pommes, 331233 Curly Fries, …), not
 *      choices for the item being built. No name, no price, no availability; serving
 *      them would hand a client nameless pills it cannot price. Dropped from the
 *      choice list (the group stays in the catalogue and simply never resolves).
 *
 * R4 — `multi_select` IS EFFECTIVE, NOT LITERAL: a group takes more than one choice
 *      iff the venue's own `multiply` says so OR its own `max_count` is > 1.
 *      The venue's two fields contradict each other, in BOTH venues:
 *        - doppelt 68406 "Deine Extras": raw API `multiply: false`, `max_count: 10`,
 *          ten priced extras (Speck +1.10, Jalapeños +0.50, …). Two extras on one
 *          burger is what that row prices; honouring `multiply: false` literally
 *          would refuse a real, priced order.
 *        - pizza "Auf Wunsch": the mirror image — `multi_select: true`, `max: 1`.
 *      `max_count` is the number the venue's own flow must respect to price the
 *      basket, so where the two disagree the count wins. For every group whose own
 *      `max_count` is 1 (or absent on a single-select group) the plan's literal rule
 *      — "multi_select: false takes at most one" — holds exactly: single-select
 *      groups are served with `max_count: 1`.
 *
 * R5 — `required` is the venue's own `is_required`; `min_count` is 1 for a required
 *      group and 0 otherwise. Nothing here infers a requirement the venue did not
 *      state.
 *
 * R6 — THE CATALOGUE IS SERVED ONCE PER VENUE, NOT REPEATED PER ITEM. See
 *      `normaliseOptionCatalogue` / tools/menu_size.ts: materialising the groups
 *      inside all 188 items costs 428 277 B, which NO relay in this project accepts
 *      (strfry frame cap 131 072 B; measured before/after in
 *      evidence/options-groups/served-menu-size.md). The item carries the group ids
 *      and its own price level; the catalogue carries the groups. A price "for that
 *      item" is then one lookup of the level key the item names — still a read.
 *
 * R7 — SOME CHOICES ARE THE ITEM'S PRICE, NOT A SURCHARGE. Exactly when the venue's
 *      own group `type` is `PriceLevelEnum` the chosen value IS the price level, so
 *      its price must NOT be added to the item's own price. Adding it double-charges.
 *      Evidence, all from the venue's own artifacts:
 *        - group 4454494 "Deine Größe" is `type: "PriceLevelEnum"`, `required: true`,
 *          one choice 43938710 "Ø 32cm" at `discounted_price 9.0 / list_price 10.0`;
 *          it is offered by 42 pizza items, item 6943882 "Pizza Margherita" among
 *          them with `price: 9.9`.
 *        - the venue's OWN rendered ordering page (evidence/
 *          rendered-ordering-page.txt, line 94) shows that dish at "9,90 € / 11,00"
 *          — the item price, not 9.90 + 9.00.
 *      So such a group is served with `absolute_price: true`, its choice is still
 *      validated and recorded on the line, and its delta is 0. Measured: 4 pizza
 *      groups are PriceLevelEnum, 2 of them referenced with more than one choice
 *      (group 4318561, a 0,75 l / 1 l drink size). Nothing is guessed: the flag is
 *      the venue's own `type` verbatim.
 */

/** One choice of one group, with every price the venue published for it (R1/R2). */
export interface OptionChoice {
  id: string;
  name: string;
  available: boolean;
  /** Keyed by the venue's own level: `default` | `1` | `2`. A missing key means the venue published no such price. */
  prices: Record<string, number>;
}

export interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  /** Effective, not literal — see R4. */
  multi_select: boolean;
  min_count: number;
  /** The venue's own count limit; 1 for a single-select group, null for an unlimited multi-select one. */
  max_count: number | null;
  /** Whether the venue marks this group's prices as depending on the item's level. */
  price_level_dependent: boolean;
  /**
   * The choice IS the item's price, not a surcharge — see R7. True exactly when the
   * venue's own `type` is `PriceLevelEnum`. Adding such a choice's price to the item's
   * own price charges the customer for the pizza twice.
   */
  absolute_price: boolean;
  choices: OptionChoice[];
}

/** A raw `menu.option_groups` row, kept untyped on purpose: the two venues differ. */
export type RawOptionGroup = Record<string, unknown>;

function numeric(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** `menu.option_groups` rows of one venue, keyed by id. */
export function optionGroupCatalogue(menu: Record<string, unknown>): Map<string, RawOptionGroup> {
  const out = new Map<string, RawOptionGroup>();
  const rows = Array.isArray(menu.option_groups) ? menu.option_groups : [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const g = row as RawOptionGroup;
    if (g.id === undefined || g.id === null) continue;
    out.set(String(g.id), g);
  }
  return out;
}

/**
 * The level key an item's own price level names: `size2` / `price_level2` are both
 * level `2`; anything else (including `default`, or an item that publishes no level)
 * reads the venue's level-independent column. The adapters spell the same fact two
 * ways; the column suffix is the level.
 */
export function priceKeyOf(priceLevelUsed: string): string {
  const m = /(?:size|price_level)([12])$/.exec(priceLevelUsed ?? "");
  return m ? m[1] : "default";
}

/** Every price the venue published for one raw choice, keyed by level (R1/R2). */
export function choicePrices(raw: Record<string, unknown>): Record<string, number> {
  const prices: Record<string, number> = {};
  const flat = ["discounted_price", "list_price", "price"].find((k) => numeric(raw[k]));
  if (flat) prices.default = raw[flat] as number;
  for (const level of [1, 2] as const) {
    const key = [`discounted_price_level${level}`, `price_level${level}`].find((k) => numeric(raw[k]));
    if (key) prices[String(level)] = raw[key] as number;
  }
  return prices;
}

/**
 * The delta this choice adds to an item at this price level. A read of the venue's
 * own numbers, in R1's order: the item's own level, then the level-independent
 * column, then nothing (the venue published no price for the choice at all, which
 * its own row and prose say means no surcharge). Never interpolated, never scaled.
 */
export function priceForItem(choice: OptionChoice, priceKey: string): number {
  const exact = choice.prices[priceKey];
  if (exact !== undefined) return exact; // (a)
  return choice.prices.default ?? 0; // (b), (c)
}

function normaliseGroup(id: string, raw: RawOptionGroup): OptionGroup {
  const rawMax = numeric(raw.max_count) ? raw.max_count : numeric(raw.max) ? raw.max : null;
  const multi = raw.multi_select === true || (rawMax !== null && rawMax > 1);
  const choices: OptionChoice[] = [];
  const rows = Array.isArray(raw.options) ? raw.options : [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const choice = row as Record<string, unknown>;
    const name = typeof choice.name === "string" ? choice.name : "";
    if (!name) continue; // R3
    if (choice.id === undefined || choice.id === null) continue;
    choices.push({
      id: String(choice.id),
      name,
      available: choice.available !== false,
      prices: choicePrices(choice),
    });
  }
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    required: raw.required === true,
    multi_select: multi,
    min_count: raw.required === true ? 1 : 0,
    max_count: multi ? rawMax : 1, // R4
    price_level_dependent: raw.price_level_dependent === true,
    absolute_price: raw.type === "PriceLevelEnum", // R7
    choices,
  };
}

/**
 * The venue's whole option catalogue, each group once (R6). This is what the `menu`
 * tool serves and what the announcement summarises.
 */
export function normaliseOptionCatalogue(menu: Record<string, unknown>): OptionGroup[] {
  return [...optionGroupCatalogue(menu).entries()].map(([id, raw]) => normaliseGroup(id, raw));
}

/**
 * The groups these ids name, resolved out of the already-normalised catalogue. An
 * id with no catalogue row is dropped: the venue published no content for it, and
 * inventing one is worse than omitting it. (Measured: no item references an id
 * outside its venue's catalogue, so nothing is dropped in the served data today.)
 */
export function groupsForItem(ids: string[], catalogue: OptionGroup[]): OptionGroup[] {
  const byId = new Map(catalogue.map((g) => [g.id, g]));
  const out: OptionGroup[] = [];
  for (const id of ids) {
    const group = byId.get(id);
    if (group) out.push(group);
  }
  return out;
}
