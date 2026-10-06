/**
 * nosms_announcement.ts — the ONE description of the nosms CEP-6 announcement (card S5a).
 *
 * Why this file exists: the nosms CVM server is Python, and it was publishing a
 * hand-rolled tag list that did not conform to the cvm-services tag contract
 * (`ADR-0001 D3/D14`, `CEP draft 0001 P2/P15`). Hand-rolling a second tag builder
 * is exactly the drift the contract exists to prevent, so the contract surface is
 * emitted through the *shared* kit and this file is the single place the nosms
 * input is described.
 *
 * Layout of the answer:
 *
 *   contract_tags = emitAnnouncementTags(NOSMS_INPUT, vocab).tags   <- the kit, authoritative
 *   payload_tags  = [name/about/website]                            <- multi-letter payload (D2)
 *   tags          = contract_tags + payload_tags                    <- what goes on the wire
 *
 * Multi-letter tags are never filterable (D2) — they are payload a reader shows,
 * not something a relay narrows on. The registry reads `name`/`about`/`website`
 * for display, so they stay, and `website` carries the same URL as the `r` tag.
 *
 * CLI:
 *   deno run --allow-read tools/nosms_announcement.ts --emit     # print the final tag set
 *   deno run --allow-read tools/nosms_announcement.ts --fixture  # regenerate the golden fixture
 *   deno run --allow-read tools/nosms_announcement.ts --check    # fail if the fixture drifted
 */
import {
  type AnnounceInput,
  assertAnnouncementTags,
  emitAnnouncementTags,
} from "../vendor/cvm-service-kit/src/mod.ts";
import { parseVocab, type Vocab } from "../vendor/cvm-service-kit/src/vocab.ts";

export const ANNOUNCEMENT_KIND = 11316;

/** The nosms contract URL — the same value carried by the `r` tag and by the CVM `docs` tool. */
export const CONTRACT_URL = "https://nosms.orangesync.tech/llms.txt";

/**
 * The advertised flat price, in sats, for one `sms.send`.
 *
 * ADR-0002 (nosms, 2026-10-05) supersedes the old 100/500 domestic/international
 * split with a single flat, risk-premium price:
 *
 *   price_sats = ceil(MULT * rail_replacement_usd * (1e8 / btc_usd)), rounded up to 100
 *              = ceil(0.5 * 4.99 * (1e8 / 86462)) = 2886 -> 2900 sats
 *
 * Flat because the rail is a single JMP/Cheogram line whose plan is unlimited
 * including international, so destination no longer maps to cost. The number here
 * is the ADVERTISED cap and MUST equal what the server actually charges; the
 * server's own source of truth is `app/pricing.py`, and the parity test in
 * `nosms` asserts the two agree.
 *
 * TODO(S5a follow-up, tracked in the card, not in this fixture): move this pin
 * into the CEP-6 announcement *content* and compare tag-vs-content in the parity
 * test, so the JSON is the single pin. Today the announcement content is built by
 * the Python server and only the tag surface is proven here.
 */
export const PRICE_SATS = 2900;

/**
 * The nosms announcement input. Everything the tag contract cares about lives
 * here; the server does not get to spell these tags out by hand.
 *
 * `required: ["payment.amount"]` is the honest declaration: the flow needs money
 * and nothing else. `to` and `body` are *tool arguments*, not flow inputs, so they
 * are not registered fields — declaring them would be the inflated appetite
 * ADR-0001 D14/P15 minimisation forbids. That makes the recomputed tier
 * `financial` (rank 1) and the kit emits the `cvm:req:none` sentinel plus
 * `cvm:tier:financial` for it.
 */
export const NOSMS_INPUT: AnnounceInput = {
  serviceClass: "sms",
  d: "nosms",
  humanTags: ["sms", "contextvm"],
  required: ["payment.amount"],
  tools: { "sms.send": { amount: PRICE_SATS } },
  urls: [CONTRACT_URL],
};

/**
 * Non-filterable payload tags (D2). They are here so a reader — the registry
 * dashboard in particular — can render a name, an about-line and a link. They are
 * NOT part of the kit's contract surface and the kit neither emits nor validates
 * them; they are appended verbatim.
 */
export const PAYLOAD_TAGS: string[][] = [
  ["name", "nosms"],
  [
    "about",
    "Send SMS on behalf of others over ContextVM. Agent-first: pay per send in Cashu. No account, no API key, no signup.",
  ],
  // The registry reads a `website` payload tag for the link; the spec's filterable
  // form is the `r` tag, which the kit emits. Both carry the same URL on purpose.
  ["website", CONTRACT_URL],
];

/**
 * CEP-8 payment declaration, appended by the CALLER because the kit does not emit
 * it yet.
 *
 * FINDING (2026-10-05, card S5a): at vendored commit `7bf4be6` the kit has no
 * `pmi` support at all — `AnnounceInput` has no payment field, `emitAnnouncementTags`
 * never pushes a `pmi` tag, and the kit's own README states "Payments (CEP-8) and
 * the ring gate are still to come". `pmi` is a MUST for a paid service (ADR-0001
 * D5, CEP-8), so it cannot simply be dropped; it is declared here, in one place,
 * with this note, and the kit gap is tracked as its own card so the emitter stops
 * being split across two owners.
 *
 * This is NOT "forking the kit": the kit's contract surface (`d`, `cvm:service:*`,
 * `cvm:req:*`, `cvm:opt:*`, `cvm:tier:*`, `g`, `cap`, `a`, `r`) is emitted only by
 * the kit. This tag is the declaration the kit does not own yet.
 */
export const PAYMENT_TAGS: string[][] = [
  ["pmi", "bitcoin-cashu", "explicit_gating"],
];

export interface NosmsAnnouncement {
  kind: number;
  /** tags as emitted by the shared kit — the contract surface */
  contract_tags: string[][];
  /** the CEP-8 declaration the kit does not own yet (see PAYMENT_TAGS) */
  payment_tags: string[][];
  /** non-filterable payload tags appended verbatim */
  payload_tags: string[][];
  /** what actually goes on the wire: contract_tags ++ payment_tags ++ payload_tags */
  tags: string[][];
  /** the recomputed tier (never supplied by the caller) */
  tier: string;
  warnings: string[];
}

/** Build the nosms announcement tags through the kit. Deterministic. */
export function buildNosmsAnnouncement(vocab: Vocab): NosmsAnnouncement {
  const { tags: contract_tags, tier, warnings } = emitAnnouncementTags(NOSMS_INPUT, vocab);

  // The emitted contract set must satisfy the reader-side contract. The kit
  // already self-checks, but this is the claim the card has to evidence, so it is
  // asserted here too — on the FULL set, payment and payload tags included, to
  // prove that appending them does not break conformance (the validator ignores
  // tag letters it does not own).
  const tags = [...contract_tags, ...PAYMENT_TAGS, ...PAYLOAD_TAGS];
  assertAnnouncementTags(tags, vocab);

  return {
    kind: ANNOUNCEMENT_KIND,
    contract_tags,
    payment_tags: PAYMENT_TAGS,
    payload_tags: PAYLOAD_TAGS,
    tags,
    tier,
    warnings,
  };
}

export function loadVocab(
  path = new URL("../vendor/cvm-service-kit/vocab/service-inputs.json", import.meta.url),
): Vocab {
  return parseVocab(JSON.parse(Deno.readTextFileSync(path)));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const fixturePath = new URL("../fixtures/nosms-11316.tags.json", import.meta.url);
  const vocab = loadVocab();
  const ann = buildNosmsAnnouncement(vocab);
  const fixture = {
    _comment:
      "GOLDEN FIXTURE — generated by tools/nosms_announcement.ts from the vendored cvm-service-kit " +
      "emitter. Do not hand-edit: regenerate with `deno task fixture` and review the diff.",
    _kit: {
      repo: "cvm-services/cvm-service-kit",
      branch: "pr/s2a-announce-emitter",
      commit: "7bf4be68a45e0a88b21f221852f3ef504b6a5807",
    },
    _generated_by: "tools/nosms_announcement.ts",
    kind: ann.kind,
    input: NOSMS_INPUT,
    tier: ann.tier,
    warnings: ann.warnings,
    contract_tags: ann.contract_tags,
    payment_tags: ann.payment_tags,
    payload_tags: ann.payload_tags,
    tags: ann.tags,
  };

  const mode = Deno.args[0] ?? "--emit";
  if (mode === "--emit") {
    console.log(JSON.stringify(ann.tags));
  } else if (mode === "--fixture") {
    Deno.writeTextFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${fixturePath.pathname}`);
  } else if (mode === "--check") {
    const onDisk = JSON.parse(Deno.readTextFileSync(fixturePath));
    const { _kit: _k1, _comment: _c1, _generated_by: _g1, ...a } = onDisk;
    const { _kit: _k2, _comment: _c2, _generated_by: _g2, ...b } = fixture;
    void [_k1, _c1, _g1, _k2, _c2, _g2];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error(
        "fixture drifted from the kit emitter:\n  on disk: " + JSON.stringify(a) +
          "\n  emitted: " + JSON.stringify(b),
      );
      Deno.exit(1);
    }
    console.log("fixture matches the kit emitter");
  } else {
    console.error(`unknown mode ${mode} (use --emit | --fixture | --check)`);
    Deno.exit(2);
  }
}
