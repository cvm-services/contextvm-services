/**
 * publish_readback_test.ts — S4a publish→read-back.
 *
 * Two things are proven here:
 *
 * 1. FINDING: `ws://100.90.101.9:7780` (the "local strfry" the card named) is a
 *    NIP-29 GROUP relay (strfry29 write-policy plugin). CEP-6 announcements
 *    carry no `h` tag, so a conforming group relay rejects them. This test
 *    publishes a group-less 11317 there and asserts it is NOT accepted —
 *    documenting the finding rather than silently treating the host as a plain
 *    strfry.
 *
 * 2. READ-BACK: against `wss://relay2.orangesync.tech` (the card's allowed 2nd
 *    target, and the relay the cvm-registry collector actually reads from),
 *    sign a real 11317, publish it, and read it back with a FRESH subscription
 *    to prove it landed. SKIPS LOUDLY (not silently) when that relay is
 *    unreachable.
 */

import { finalizeEvent, generateSecretKey } from "npm:nostr-tools/pure";
import { emitAnnouncement, parseVocab, type Vocab } from "../vendor/cvm-service-kit/src/mod.ts";
import { venueToAnnouncement, type VenueRecord } from "../tools/venue_to_announcement.ts";

const LOCAL_GROUP_RELAY = "ws://100.90.101.9:7780";
const PUBLISH_RELAY = "wss://relay2.orangesync.tech";

const VOCAB: Vocab = parseVocab(
  JSON.parse(await Deno.readTextFile(new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url))),
);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

function reachable(url: string, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); resolve(false); }, timeoutMs);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
}

/** Open, send EVENT, await OK. Returns {accepted, msg}. */
async function publishOnce(url: string, event: unknown): Promise<{ accepted: boolean; msg: string }> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), 10000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error("open failed")); };
  });
  return new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data));
      if (d[0] === "OK") resolve({ accepted: d[2] === true, msg: `${d[2]} ${d[3]}` });
    };
    ws.send(JSON.stringify(["EVENT", event]));
    setTimeout(() => resolve({ accepted: false, msg: "timeout awaiting OK" }), 10000);
  });
}

/** Fresh subscription: collect events matching a filter until EOSE or timeout. */
async function readBack(url: string, filter: unknown, timeoutMs = 8000): Promise<unknown[]> {
  const events: unknown[] = [];
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), 10000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error("open failed")); };
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data));
      if (d[0] === "EVENT") events.push(d[2]);
      if (d[0] === "EOSE") resolve();
    };
    ws.send(JSON.stringify(["REQ", "s4a-readback", filter]));
    setTimeout(resolve, timeoutMs);
  });
  ws.close();
  return events;
}

Deno.test("FINDING: the 'local strfry' is a NIP-29 group relay and rejects CEP-6 announcements", async () => {
  if (!await reachable(LOCAL_GROUP_RELAY)) {
    console.error(`\n[SKIP] local relay ${LOCAL_GROUP_RELAY} unreachable (nothing to document)\n`);
    return; // loud skip
  }
  const v = JSON.parse(
    await Deno.readTextFile(new URL("../.scratch/venues/doppelt-kaese-berlin.json", import.meta.url)),
  ) as VenueRecord;
  const { input } = venueToAnnouncement(v);
  const emitted = emitAnnouncement(input, VOCAB);
  const sk = generateSecretKey();
  const signed = finalizeEvent({
    kind: 11317,
    created_at: Math.floor(Date.now() / 1000),
    tags: emitted.tags,
    content: "{\"tools\":[]}",
  }, sk);
  const res = await publishOnce(LOCAL_GROUP_RELAY, signed);
  // A NIP-29 group relay MUST reject a group-less event (no `h` tag).
  console.error(`[FINDING] local relay ${LOCAL_GROUP_RELAY}: ${res.accepted ? "ACCEPTED" : "rejected"} (${res.msg})`);
  assert(!res.accepted, `expected the group relay to reject a group-less 11317, got: ${res.msg}`);
});

Deno.test("publish a real 11317 to relay2.orangesync.tech and read it back", async () => {
  if (!await reachable(PUBLISH_RELAY)) {
    console.error(
      `\n[SKIP] ${PUBLISH_RELAY} is unreachable — publish→read-back NOT verified. ` +
      `The card must be blocked, not completed.\n`,
    );
    return; // loud skip
  }

  const v = JSON.parse(
    await Deno.readTextFile(new URL("../.scratch/venues/pizza-e-pasta-ruedesheimerplatz.json", import.meta.url)),
  ) as VenueRecord;
  const { input } = venueToAnnouncement(v);
  const emitted = emitAnnouncement(input, VOCAB);

  const sk = generateSecretKey();
  const signed = finalizeEvent({
    kind: 11317,
    created_at: Math.floor(Date.now() / 1000),
    tags: emitted.tags,
    content: "{\"tools\":[]}",
  }, sk);

  const res = await publishOnce(PUBLISH_RELAY, signed);
  assert(res.accepted, `publish to ${PUBLISH_RELAY} failed: ${res.msg}`);
  console.error(`[READ-BACK] published 11317 id=${signed.id} -> ${PUBLISH_RELAY}`);

  // fresh subscription: filter by author, expect our event back
  const back = await readBack(PUBLISH_RELAY, { kinds: [11317], authors: [signed.pubkey], limit: 10 });
  const found = back.find((e) => (e as { id: string }).id === signed.id);
  assert(found, `read-back did not return the published event id ${signed.id}`);
  console.error(`[READ-BACK] confirmed event ${signed.id} on ${PUBLISH_RELAY}`);
});
