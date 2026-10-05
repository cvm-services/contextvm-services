/**
 * The live announcement matches the kit's emitter (offline regression check).
 *
 * `tools/nosms_announcement_test.ts` proves the KIT is conformant. This file
 * proves the thing that is actually PUBLISHED is that same set: it reads a
 * captured `nak req` read-back of the live kind-11316 and diffs its contract
 * surface against the kit emitter's output, tag for tag.
 *
 * Why an offline check and not a live one: a test that needs a relay fails for
 * reasons that are not the code (relay down, IP-banned, no network) and cannot
 * run in CI. The capture is a committed artifact with the event id recorded, so
 * the comparison is exact and reproducible; `evidence/S5a-live-announcement.md`
 * carries the fresh capture each re-announce.
 *
 * Run: deno task test  (this file is collected with the rest)
 */
import { buildNosmsAnnouncement, loadVocab } from "./nosms_announcement.ts";

const CAPTURE = new URL("../evidence/nosms-11316.live.json", import.meta.url);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

const vocab = loadVocab();

interface Captured {
  kind: number;
  id: string;
  pubkey: string;
  tags: string[][];
}

Deno.test("live capture: the published kind-11316 carries exactly the emitted contract surface", () => {
  const live: Captured = JSON.parse(Deno.readTextFileSync(CAPTURE));
  const emitted = buildNosmsAnnouncement(vocab);

  assert(live.kind === 11316, `live kind is 11316, got ${live.kind}`);

  // The kit-owned surface must appear verbatim, in the kit's own order. Filtering
  // the live tags to the letters the kit owns keeps this robust to payload
  // additions while still failing if a contract tag is missing/renamed/reordered.
  const kitLetters = new Set(["d", "t", "g", "cap", "a", "r"]);
  const liveContract = live.tags.filter((t) => kitLetters.has(t[0]));
  assert(
    JSON.stringify(liveContract) === JSON.stringify(emitted.contract_tags),
    `live contract surface != emitted:\n  live: ${JSON.stringify(liveContract)}\n  emit: ${
      JSON.stringify(emitted.contract_tags)
    }`,
  );

  // the payment declaration rode along (the kit does not emit pmi at this commit)
  const pmi = live.tags.filter((t) => t[0] === "pmi");
  assert(
    pmi.length === 1 && pmi[0][1] === "bitcoin-cashu",
    `exactly one bitcoin-cashu pmi, got ${JSON.stringify(pmi)}`,
  );
});

Deno.test("live capture: the old defects are provably gone", () => {
  const live: Captured = JSON.parse(Deno.readTextFileSync(CAPTURE));
  const letters = live.tags.map((t) => t[0]);

  assert(!letters.includes("contract"), "the non-standard `contract` tag is gone");
  assert(live.tags.filter((t) => t[0] === "cap").length === 1, "ONE cap, not the old three");
  assert(!letters.includes("g"), "no meaningless geohash (P2)");

  const t = live.tags.filter((x) => x[0] === "t").map((x) => x[1]);
  assert(t.includes("cvm:service:sms"), "namespaced class present");
  assert(t.includes("cvm:req:none"), "sentinel present");
  assert(t.filter((v) => v.startsWith("cvm:tier:")).length === 1, "exactly one tier tag");
});
