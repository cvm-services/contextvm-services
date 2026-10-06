/**
 * emit-review.ts — build, sign and (optionally) publish one review event.
 *
 *   deno run --allow-read --allow-net --allow-write tools/emit-review.ts \
 *     --venue venues/doppelt-kaese-berlin/venue.json \
 *     --provider-key-file .scratch/doppelt-kaese-berlin.nsec \
 *     --key-file .scratch/reviewer.nsec \
 *     --rating 5 --content "Best Käse in Kreuzberg, 3 min from the U-Bahn." \
 *     --relays ws://127.0.0.1:7781 [--dry-run]
 *
 * `--dry-run` prints the unsigned template + the signing identity and is the
 * evidence artifact: deterministic tags, no key material, no network.
 *
 * The slug / deep-link / geohashes are NOT re-invented here: they are read back
 * out of the announcement this tool builds for the same venue.json, so a review
 * cannot bind to values that differ from what the venue actually announced.
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { emitAnnouncement, parseVocab } from "../vendor/cvm-service-kit/src/mod.ts";
import { venueToAnnouncement } from "./venue_to_announcement.ts";
import { buildReviewEvent, type ReviewInput } from "./review_event.ts";
import { fail, publish, readKey, relayList } from "./nostr.ts";

const VOCAB_PATH = new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url);

function tagsOf(event: { tags?: string[][] }, name: string): string[] {
  return (event.tags ?? []).filter((t) => t[0] === name).map((t) => t[1]);
}

async function main() {
  const flags = parse(Deno.args, {
    string: ["venue", "key-file", "provider-key-file", "provider-pubkey", "rating",
             "content", "relays", "created-at"],
    boolean: ["dry-run", "help"],
    alias: { h: "help" },
  });

  if (flags.help || !flags.venue || !flags.rating || !flags.content) {
    console.log(
      "usage: emit-review.ts --venue <venue.json> --rating <1..5> --content <text> " +
        "--key-file <reviewer nsec file> (--provider-pubkey <hex> | --provider-key-file <file>) " +
        "[--relays wss://…] [--dry-run]",
    );
    Deno.exit(0);
  }

  // 1. Rebuild the announcement for this venue.json and take the bindings from it.
  const venueRaw = JSON.parse(await Deno.readTextFile(flags.venue));
  const vocab = parseVocab(JSON.parse(await Deno.readTextFile(VOCAB_PATH)));
  const { input } = venueToAnnouncement(venueRaw);
  const announced = emitAnnouncement(input, vocab);
  const slug = tagsOf(announced, "d")[0];
  const url = tagsOf(announced, "r")[0];
  const geohashes = tagsOf(announced, "g");
  if (!slug || !url || geohashes.length === 0) {
    fail("the announcement for this venue.json lacks d / r / g — fix the venue record first");
  }

  // 2. Who is being reviewed.
  let providerPubkey = flags["provider-pubkey"];
  if (!providerPubkey) {
    if (!flags["provider-key-file"]) {
      fail("need --provider-pubkey <hex> or --provider-key-file <file> to identify the reviewed provider");
    }
    providerPubkey = (await readKey(String(flags["provider-key-file"]), false)).hex;
  }
  if (!/^[0-9a-f]{64}$/.test(providerPubkey)) fail("provider pubkey is not 64-char hex");

  // 3. The review itself — the reviewer signs with their OWN key.
  const rating = Number(flags.rating);
  const created = flags["created-at"] ? Number(flags["created-at"]) : Math.floor(Date.now() / 1000);
  const reviewInput: ReviewInput = {
    venue_slug: slug,
    provider_pubkey: providerPubkey,
    venue_url: url,
    rating,
    geohashes,
    content: String(flags.content),
    created_at: created,
  };
  const template = buildReviewEvent(reviewInput);

  const reviewer = await readKey(String(flags["key-file"]), !flags["dry-run"]);

  console.log(JSON.stringify({
    review: template,
    binds_to: { venue_slug: slug, venue_url: url, geohashes, provider_pubkey: providerPubkey },
    reviewer: { npub: reviewer.npub },
    note:
      "kind is addressable (30000–39999) on purpose: the 10000–19999 range is " +
      "replaceable, so every review by one author would overwrite the last.",
  }, null, 2));

  if (flags["dry-run"]) return;

  const relays = relayList(flags.relays);
  if (relays.length === 0) fail("--relays required to publish");

  const { signEvent } = await import("./nostr.ts");
  const signed = signEvent(reviewer.hex, template as unknown as Record<string, unknown>) as {
    id: string; pubkey: string;
  };
  console.log(`signed review id=${signed.id} reviewer=${signed.pubkey}`);

  let any = false;
  for (const r of relays) {
    try {
      const res = await publish(r, signed);
      console.error(`publish ${r}: ${res.accepted ? "accepted" : "REJECTED"} (${res.msg})`);
      any = any || res.accepted;
    } catch (e) {
      console.error(`publish ${r}: failed (${(e as Error).message})`);
    }
  }
  if (!any) fail("no relay accepted the review");
}

if (import.meta.main) await main();
