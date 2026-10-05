/**
 * emit-attestation.ts — a venue signs a vouch for a reviewer (R4a, kind 30317).
 *
 *   deno run --allow-read --allow-net --allow-write tools/emit-attestation.ts \
 *     --venue <venue.json> --provider-key-file .scratch/<venue>.nsec \
 *     --reviewer-pubkey <hex64> [--review-event-id <hex64>] [--claim <text>] \
 *     [--dry-run]
 *
 * The signing key MUST be the venue's own key — the same one that signed the
 * announcement. The collector honours an attestation only when its author equals
 * the announcement's pubkey, so signing with anything else produces a badge that
 * never appears. That is deliberate: a vouch is worth exactly the venue's identity.
 *
 * NOTE ON THE CLAIM. The default wording is narrow on purpose. This event proves
 * the venue said it — not that the reviewer was present. Publishing it as
 * "verified visit" or "proof of place" would be a claim the cryptography cannot
 * back. The ring tier (R4b) is what could; it is not implemented, and this badge
 * must not be dressed up to look like it.
 *
 * The venue slug is read back out of the announcement this same tool rebuilds, so
 * an attestation can never bind to a slug different from the one announced.
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { emitAnnouncement, parseVocab } from "../vendor/cvm-service-kit/src/mod.ts";
import { venueToAnnouncement } from "./venue_to_announcement.ts";
import { buildAttestation } from "./attestation_event.ts";
import { fail, publish, readKey, relayList, signEvent } from "./nostr.ts";

const VOCAB_PATH = new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url);
const DEFAULT_CLAIM = "This reviewer placed an order at this venue.";

function tagsOf(event: unknown, name: string): string[] {
  const tags = (event as { tags?: string[][] }).tags ?? [];
  return tags.filter((t) => t[0] === name).map((t) => t[1]);
}

if (import.meta.main) {
  const flags = parse(Deno.args, {
    string: ["venue", "provider-key-file", "reviewer-pubkey", "review-event-id", "claim", "relays", "created-at"],
    boolean: ["dry-run"],
    alias: { r: "relays" },
  }) as Record<string, string | boolean | undefined>;

  const venuePath = flags["venue"] as string | undefined;
  const keyFile = flags["provider-key-file"] as string | undefined;
  const reviewer = flags["reviewer-pubkey"] as string | undefined;
  if (!venuePath || !keyFile || !reviewer) {
    fail("usage: --venue <venue.json> --provider-key-file <file> --reviewer-pubkey <hex64> [--dry-run]");
  }

  const key = await readKey(keyFile, false);
  const venueRaw = JSON.parse(await Deno.readTextFile(venuePath));
  const vocab = parseVocab(JSON.parse(await Deno.readTextFile(VOCAB_PATH)));
  const { input } = venueToAnnouncement(venueRaw);

  // Read the slug from the announcement actually emitted, not from the raw record.
  const announced = emitAnnouncement(input, vocab) as unknown;
  const slug = tagsOf(announced, "d")[0];
  if (!slug) fail("could not read the venue slug out of the emitted announcement");

  const created_at = flags["created-at"]
    ? Number(flags["created-at"])
    : Math.floor(Date.now() / 1000);
  const claim = (flags["claim"] as string | undefined) ?? DEFAULT_CLAIM;

  const body = {
    kind: 30317,
    created_at,
    tags: buildAttestation({
      venue_slug: slug,
      reviewer_pubkey: reviewer,
      provider_pubkey: key.pubkey_hex,
      review_event_id: flags["review-event-id"] as string | undefined,
      claim,
      created_at,
    }).tags,
    content: claim,
  };

  const signed = signEvent(key.secret_hex, body) as { id: string; pubkey: string };

  if (flags["dry-run"]) {
    console.log(JSON.stringify(signed, null, 2));
    Deno.exit(0);
  }

  const relays = relayList(flags["relays"]);
  if (!relays.length) fail("no relays given (--relays ws://…,…)");

  console.log(
    `signed attestation id=${signed.id} venue=${key.npub} reviewer=${reviewer.slice(0, 16)}… slug=${slug}`,
  );
  let accepted = 0;
  for (const relay of relays) {
    const res = await publish(relay, signed);
    console.log(`publish ${relay}: accepted (${res.accepted} )`);
    if (res.accepted) accepted++;
  }
  if (!accepted) fail("no relay accepted the attestation");
}
