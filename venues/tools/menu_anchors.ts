#!/usr/bin/env -S deno run --allow-read
// menu_anchors.ts — generate / check the COMMITTED verification anchor.
//
// Usage:
//   deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write
//   deno run --allow-read               venues/tools/menu_anchors.ts --check
//
// WHY: the served menu must be verified against something that is NOT derived
// from `venues/` at test time, or any record passes — including a fabricated
// one with no evidence and invented prices (see services/restaurant-cvm/anchor.ts
// for the full account). `venues/anchors.json` is that something: a committed
// expectation of the served contract, per venue.
//
// Writing it is an explicit command, so onboarding a venue or re-capturing one
// shows up as a diff to a file someone reviews. This tool REFUSES to anchor a
// venue that has no committed evidence on disk, so a hand-typed record cannot
// be made to pass by regenerating the anchor either.
//
// Exit codes: 0 ok, 1 the committed anchor does not match, 2 refusal/error.

import {
  anchorFileText,
  ANCHOR_URL,
  buildAnchor,
  evidenceProblem,
  readAnchor,
  readVenueRaw,
} from "../../services/restaurant-cvm/anchor.ts";
import { loadVenueSet } from "../../services/restaurant-cvm/server.ts";

async function main(): Promise<number> {
  const write = Deno.args.includes("--write");
  const { venues, rejections } = await loadVenueSet();

  for (const r of rejections) {
    console.error(`[anchors] venue REFUSED by the adapter contract: ${r.slug} — ${r.reason}`);
  }

  // A served venue without evidence is a hand-typed record. Refuse to anchor it:
  // an anchor that can be regenerated around a fabricated venue is not a gate.
  const problems: string[] = [];
  for (const venue of venues) {
    const problem = await evidenceProblem(venue.slug, await readVenueRaw(venue.slug));
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`[anchors] REFUSING: ${p}`);
    return 2;
  }

  const anchor = await buildAnchor(venues);
  const text = anchorFileText(anchor);

  if (write) {
    await Deno.writeTextFile(ANCHOR_URL, text);
    console.log(
      `WROTE venues/anchors.json venues=${anchor.served_venues.length} ` +
        `items=${anchor.total_items} menu_sha256=${anchor.menu_sha256.slice(0, 12)}`,
    );
    return 0;
  }

  let committed: string;
  try {
    committed = await readAnchor().then((a) => anchorFileText(a));
  } catch (err) {
    console.error(`[anchors] FAIL ${(err as Error).message}`);
    return 2;
  }

  if (committed !== text) {
    console.error(
      `[anchors] FAIL: the committed anchor does not match the venue records.\n` +
        `  committed venues=${JSON.stringify(JSON.parse(committed).served_venues)} ` +
        `items=${JSON.parse(committed).total_items} sha=${JSON.parse(committed).menu_sha256.slice(0, 12)}\n` +
        `  recomputed venues=${JSON.stringify(anchor.served_venues)} ` +
        `items=${anchor.total_items} sha=${anchor.menu_sha256.slice(0, 12)}\n` +
        `  If the record change is intended, regenerate it on purpose and commit the diff:\n` +
        `    deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write`,
    );
    return 1;
  }
  console.log(
    `CHECK OK venues/anchors.json venues=${anchor.served_venues.length} ` +
      `items=${anchor.total_items} menu_sha256=${anchor.menu_sha256.slice(0, 12)}`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    console.error(`[anchors] ERROR ${(err as Error).message}`);
    Deno.exit(2);
  }
}
