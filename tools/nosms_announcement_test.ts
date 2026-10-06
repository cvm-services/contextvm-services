/**
 * nosms_announcement_test.ts — the conformant nosms CEP-6 announcement (card S5a).
 *
 * Two things are proven here, and they are different claims:
 *
 *   1. the announcement EMITTED through the shared kit satisfies the tag contract
 *      (the card's definition of done), and
 *   2. the SHARED KIT still reproduces the golden fixture that the Python port in
 *      `nosms` is diffed against — i.e. the thing the parity test compares to has
 *      not silently drifted.
 *
 * Run: deno task test
 */
import {
  buildNosmsAnnouncement,
  CONTRACT_URL,
  loadVocab,
  NOSMS_INPUT,
  PRICE_SATS,
} from "./nosms_announcement.ts";
import {
  assertAnnouncementTags,
  assessAnnouncementTags,
} from "../vendor/cvm-service-kit/src/validate.ts";
import { recomputeTierFromTags, tagValues } from "../vendor/cvm-service-kit/src/vocab.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

const FIXTURE = new URL("../fixtures/nosms-11316.tags.json", import.meta.url);
const vocab = loadVocab();

Deno.test("the emitted tag set conforms: assertAnnouncementTags returns OK", () => {
  const ann = buildNosmsAnnouncement(vocab);
  const assessment = assertAnnouncementTags(ann.tags, vocab);
  assert(assessment.violations.length === 0, "no violations");
  assert(assessment.tierMismatch === false, "tier tag agrees with the declared fields");
  assert(assessment.effective === ann.tier, "effective tier is the emitted tier");
});

Deno.test("gap 1/2/3 — the three P2/P15 tags the old live event was missing are present", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  const t = tagValues(tags, "t");
  assert(t.includes("cvm:service:sms"), "cvm:service:sms (P2 MUST)");
  assert(t.includes("cvm:req:payment.amount"), "cvm:req:payment.amount (declared flow input)");
  assert(t.includes("cvm:req:none"), "cvm:req:none sentinel (P15 sentinel)");
  assert(t.includes("cvm:tier:financial"), "cvm:tier:<tier> (tier filter)");
  // exactly one tier tag — the max-only rule
  const tiers = t.filter((v) => v.startsWith("cvm:tier:"));
  assert(tiers.length === 1, `exactly one tier tag, found ${tiers.length}`);
});

Deno.test("gap 4 — no geohash: the service has no fixed location, so it MUST NOT publish one", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  const g = tagValues(tags, "g");
  assert(g.length === 0, "no `g` tag (P2: MUST NOT publish a meaningless geohash)");
  // and no other geohash-shaped tag smuggled in under another letter
  assert(
    !tags.some((t) => t[0] !== "t" && t[0] !== "d" && /^[0-9b-hjkmnp-z]{4,}$/.test(t[1] ?? "")),
    "no tag value looks like a geohash",
  );
});

Deno.test("gap 5 — the contract URL rides the standard `r` tag, not a non-standard `contract` tag", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  assert(tagValues(tags, "r").includes(CONTRACT_URL), "`r` carries the contract URL (P2 SHOULD)");
  assert(!tags.some((t) => t[0] === "contract"), "no non-standard `contract` tag");
});

Deno.test("gap 6 — one honest `cap` per tool, flat, equal to the advertised price", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  const caps = tags.filter((t) => t[0] === "cap");
  assert(caps.length === 1, `exactly one cap tag, found ${caps.length} (the old event had THREE)`);
  assert(caps[0][1] === "tool:sms.send", "cap names tool:sms.send");
  assert(
    caps[0][2] === String(PRICE_SATS),
    `cap amount is the flat advertised price ${PRICE_SATS}`,
  );
  assert(caps[0][3] === "sats", "cap unit is sats");
  // the old event carried 100 + 500 + 500 for the same tool, which is neither the
  // old per-prefix table (100/500) nor the ADR-0002 flat price. Assert the defect
  // is gone in both directions.
  const amounts = caps.map((c) => Number(c[2]));
  assert(!amounts.includes(100) && !amounts.includes(500), "no stale 100/500 prices");
});

Deno.test("FINDING — the kit emits no `pmi`; the declaration is appended by the caller and labelled", () => {
  const ann = buildNosmsAnnouncement(vocab);
  // the kit's own contract surface has no pmi tag ...
  assert(
    !ann.contract_tags.some((t) => t[0] === "pmi"),
    "kit emits no pmi (CEP-8 out of scope at 7bf4be6)",
  );
  // ... so it is declared by the caller, in exactly one place, and IS on the wire
  assert(ann.payment_tags.length === 1, "one pmi declaration");
  const pmi = ann.tags.find((t) => t[0] === "pmi");
  assert(
    pmi !== undefined && pmi[1] === "bitcoin-cashu" && pmi[2] === "explicit_gating",
    "pmi bitcoin-cashu explicit_gating survives onto the wire (CEP-8 / ADR-0001 D5)",
  );
  assert(ann.tags.filter((t) => t[0] === "pmi").length === 1, "exactly one pmi tag");
});

Deno.test("only single-letter tags are filterable — every multi-letter tag here is payload", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  const multi = tags.filter((t) => t[0].length > 1).map((t) => t[0]);
  assert(
    JSON.stringify([...new Set(multi)].sort()) ===
      JSON.stringify(["about", "cap", "name", "pmi", "website"]),
    `multi-letter tags are payload only: got ${[...new Set(multi)].sort().join(",")}`,
  );
  // the single-letter (relay-filterable) surface is exactly d/r/t. NOTE: `r` is a
  // single-letter tag too — the card's pitfall list mentions "t/d/g" but `r` is
  // filterable by the same rule, which is why moving the contract URL off a
  // non-standard `contract` tag onto `r` is a real discovery improvement.
  const single = [...new Set(tags.filter((t) => t[0].length === 1).map((t) => t[0]))].sort();
  assert(
    JSON.stringify(single) === JSON.stringify(["d", "r", "t"]),
    `the only single-letter tags are d, r and t: got ${single.join(",")}`,
  );
  // and every `t` value a relay would filter on is present as a distinct value
  assert(tagValues(tags, "t").includes("cvm:tier:financial"), "#t cvm:tier:* is filterable");
});

Deno.test("determinism — the same input yields a byte-identical tag list", () => {
  const a = JSON.stringify(buildNosmsAnnouncement(vocab).tags);
  const b = JSON.stringify(buildNosmsAnnouncement(vocab).tags);
  assert(a === b, "idempotent re-publish");
});

Deno.test("the tier is COMPUTED, not supplied: the caller's input has no tier field", () => {
  assert(!("tier" in NOSMS_INPUT), "AnnounceInput carries no tier");
  const { tags, tier } = buildNosmsAnnouncement(vocab);
  const rec = recomputeTierFromTags(tags, vocab);
  assert(rec.tier === tier, "emitted tier == recomputed tier");
  assert(tier === "financial", "payment.amount is a financial-tier field");
});

Deno.test("golden fixture: the kit still reproduces fixtures/nosms-11316.tags.json", () => {
  const onDisk = JSON.parse(Deno.readTextFileSync(FIXTURE));
  const live = buildNosmsAnnouncement(vocab);
  assert(JSON.stringify(onDisk.tags) === JSON.stringify(live.tags), "fixture tags identical");
  assert(
    JSON.stringify(onDisk.contract_tags) === JSON.stringify(live.contract_tags),
    "contract tags identical",
  );
  assert(JSON.stringify(onDisk.input) === JSON.stringify(NOSMS_INPUT), "fixture input identical");
  assert(onDisk.tier === live.tier, "fixture tier identical");
  // the fixture must also be internally consistent: its own set conforms
  assertAnnouncementTags(onDisk.tags, vocab);
});

Deno.test("the fixture is not accidentally the old broken live event", () => {
  const onDisk = JSON.parse(Deno.readTextFileSync(FIXTURE));
  const t = tagValues(onDisk.tags, "t");
  assert(!t.includes("cvm:service:contextvm"), "no invented class");
  assert(onDisk.tags.filter((x: string[]) => x[0] === "cap").length === 1, "not three caps");
});

Deno.test("assessment surfaces no warnings a client would have to reconcile", () => {
  const { tags } = buildNosmsAnnouncement(vocab);
  const a = assessAnnouncementTags(tags, vocab);
  const sentinelWarnings = a.warnings.filter((w) => w.includes("sentinel"));
  assert(
    sentinelWarnings.length === 0,
    `the sentinel is present exactly when the tier needs it: ${sentinelWarnings.join("; ")}`,
  );
});
