/**
 * Convert a venue's EUR menu into a sats menu.
 *
 * A RATE IS NEVER INVENTED. This refuses to run without an explicit
 * --rate-sats-per-eur and --rate-source, because a hardcoded or guessed rate is
 * exactly the bug that overpaid a real invoice by 3.1x (a stale rate implied BTC
 * $25.8k when it was ~$80.2k).
 *
 * Even with a rate, the invoice remains authoritative: the settlement core locks
 * the order price to the amount the rail encodes, so a drifting rate can never
 * change what the customer is charged after the invoice exists.
 *
 *   deno run --allow-read --allow-write tools/menu_to_sats.ts \
 *     --venue venues/three-buddies-berlin/venue.json \
 *     --out venues/three-buddies-berlin/menu.sats.json \
 *     --rate-sats-per-eur 1250 --rate-source "fixture"
 */
const arg = (name: string): string => {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? String(Deno.args[i + 1] ?? "") : "";
};

const venuePath = arg("--venue");
const outPath = arg("--out");
const rateRaw = arg("--rate-sats-per-eur");
const rateSource = arg("--rate-source");

if (!venuePath || !outPath || !rateRaw || !rateSource) {
  console.error(JSON.stringify({
    error: "refusing to convert without an explicit rate and its provenance",
    need: ["--venue", "--out", "--rate-sats-per-eur", "--rate-source"],
    why: "a guessed rate is how an invoice gets overpaid by 3.1x",
  }));
  Deno.exit(2);
}

const rate = Number(rateRaw);
if (!Number.isFinite(rate) || rate <= 0) {
  console.error(JSON.stringify({ error: "rate must be a positive number", got: rateRaw }));
  Deno.exit(2);
}

const venue = JSON.parse(await Deno.readTextFile(venuePath));
const items: Array<Record<string, unknown>> = venue?.menu?.items ?? [];
if (!Array.isArray(items) || items.length === 0) {
  console.error(JSON.stringify({ error: "venue has no menu.items", venue: venuePath }));
  Deno.exit(3);
}

const out = items.map((it) => {
  const prices = it.prices_by_order_method ?? {};
  // dine_in is the indoor price; fall back to pickup, then any value present.
  const eur = Number(prices.dine_in ?? prices.pickup ?? Object.values(prices)[0] ?? NaN);
  if (!Number.isFinite(eur) || eur <= 0) return null;
  // Round UP by a whole sat: never undercharge the venue, never leave a 0-sat item.
  const sats = Math.max(1, Math.ceil(eur * rate));
  return {
    id: String(it.sku ?? it.id ?? ""),
    name: String(it.name ?? ""),
    sats,
    eur,
  };
}).filter(Boolean);

await Deno.writeTextFile(outPath, JSON.stringify({
  venue: venue?.venue?.name ?? venue?.slug ?? "venue",
  currency_generated_from: venue?.menu?.currency ?? "EUR",
  rate_sats_per_eur: rate,
  rate_source: rateSource,
  generated_at: new Date().toISOString(),
  note: "The invoice's own amount is authoritative at settlement; this rate only prices the display.",
  items: out,
}, null, 2));

console.log(JSON.stringify({
  out: outPath, items: out.length, rate, rate_source: rateSource,
  warning: rateSource === "fixture" ? "FIXTURE RATE - not a live market rate" : undefined,
}));
