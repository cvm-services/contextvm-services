/**
 * emit-venue-announcement.ts — S4a CLI.
 *
 * Builds the CEP-6 announcements (kinds 11316 + 11317) for a venue record and
 * either prints the full event JSON (`--dry-run`, the evidence artifact) or
 * signs + publishes the NIP-01 events to the given relays.
 *
 *   deno run --allow-read --allow-net --allow-write tools/emit-venue-announcement.ts \
 *     --venue venues/doppelt-kaese-berlin/venue.json --kind 11317 \
 *     --key-file .scratch/service.nsec --relays wss://relay2.orangesync.tech --dry-run
 *
 * The tier is never supplied: the vendored emitter recomputes `cvm:tier:<max>`
 * and this CLI asserts the emitted tag equals the recomputed value before
 * printing or publishing anything.
 *
 * NOTE (2026-10-05): one key per venue. kind 11316/11317 are in NIP-16's
 * replaceable range, so relays key them by (kind, pubkey) alone — signing two
 * venues with one key makes each announcement silently overwrite the other.
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { emitAnnouncement, parseVocab, recomputeTier } from "../vendor/cvm-service-kit/src/mod.ts";
import { venueToAnnouncement } from "./venue_to_announcement.ts";
import { fail, publish, readKey, relayList, signEvent } from "./nostr.ts";

const VOCAB_PATH = new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url);
const ANNOUNCE_SERVER = 11316;
const ANNOUNCE_TOOLS = 11317;

async function main() {
  const flags = parse(Deno.args, {
    string: ["venue", "kind", "key-file", "relays"],
    boolean: ["dry-run", "help"],
    alias: { h: "help" },
  });

  if (flags.help || !flags.venue) {
    console.log(
      "usage: emit-venue-announcement.ts --venue <venue.json> [--kind 11316|11317] " +
        "--key-file <nsec file> [--relays wss://...] [--dry-run]",
    );
    Deno.exit(0);
  }

  const kind = flags.kind ? Number(flags.kind) : ANNOUNCE_SERVER;
  if (kind !== ANNOUNCE_SERVER && kind !== ANNOUNCE_TOOLS) {
    fail(`--kind must be ${ANNOUNCE_SERVER} or ${ANNOUNCE_TOOLS}`);
  }

  const venuePath = flags.venue.startsWith("/") ? flags.venue : `${Deno.cwd()}/${flags.venue}`;
  const venueRaw = JSON.parse(await Deno.readTextFile(venuePath));
  const vocabRaw = JSON.parse(await Deno.readTextFile(VOCAB_PATH));
  const vocab = parseVocab(vocabRaw);

  const { input, content } = venueToAnnouncement(venueRaw);

  // Build via the vendored emitter — it computes the tier, we never supply it.
  const emitted = emitAnnouncement(input, vocab);

  // Assert the emitted tier equals the recomputed max (the contract, S4a).
  const rec = recomputeTier(
    {
      required: input.required ?? [],
      optional: input.optional ?? [],
      noneSentinel: false,
      unclassified: false,
    },
    vocab,
  );
  if (emitted.tier !== rec.tier) {
    fail(`emitted tier '${emitted.tier}' != recomputed '${rec.tier}' (kit bug)`);
  }
  const tierTag = emitted.tags.find((t) => t[0] === "t" && t[1].startsWith("cvm:tier:"));
  if (!tierTag || tierTag[1] !== `cvm:tier:${rec.tier}`) {
    fail(`no cvm:tier:<max> tag equal to recomputed value`);
  }

  const relays = relayList(flags.relays);

  const eventContent = kind === ANNOUNCE_SERVER
    ? JSON.stringify(content)
    : JSON.stringify({ tools: (content as { tools: unknown }).tools });

  if (flags["dry-run"]) {
    console.log(JSON.stringify({
      kind,
      pubkey: null, // unsigned in dry-run
      tags: emitted.tags,
      content: eventContent,
      tier: emitted.tier,
      recomputed_tier: rec.tier,
      warnings: emitted.warnings,
    }, null, 2));
    Deno.exit(0);
  }

  if (!flags["key-file"]) fail("--key-file required to publish");
  if (relays.length === 0) fail("--relays required to publish");

  const key = await readKey(String(flags["key-file"]), true);
  console.error(`service npub ${key.npub}`);

  const unsigned = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: emitted.tags,
    content: eventContent,
  };
  const signed = signEvent(key.secret_hex, unsigned);

  console.log(JSON.stringify(signed, null, 2));
  for (const r of relays) {
    const res = await publish(r, signed);
    console.error(`publish ${r}: ${res.accepted ? "accepted" : "REJECTED"} (${res.msg})`);
    if (!res.accepted) fail(`relay ${r} rejected the event`);
  }
}

if (import.meta.main) await main();
