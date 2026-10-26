/**
 * Report on the treasury journal. READ-ONLY by default.
 *
 * Resolving an entry requires the wallet's answer; this tool will not write a
 * terminal state from inference. `--apply <truth.json>` exists for when the
 * wallet has actually been asked, and refuses entries with no evidence.
 */
import { applyWalletTruth, classifyEntry, summarise, type JournalEntry } from "../src/journal_reconcile.ts";

const path = Deno.env.get("JOURNAL") ?? `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;
const raw = JSON.parse(await Deno.readTextFile(path)) as JournalEntry[];

const summary = summarise(raw);
const redact = (b?: string) => (b ? `#${b.slice(-8)}` : "(none)");

console.log(JSON.stringify({
  journal: path,
  total_entries: summary.total_entries,
  settled_sats: summary.settled_sats,
  unknown_sats: summary.unknown_sats,
  unverified_sats: summary.unverified_sats,
  clean: summary.clean,
  entries: raw.map((e) => {
    const c = classifyEntry(e);
    return { quote: c.quote_id.slice(0, 8), sats: c.sats, kind: c.kind, state: e.state, reason: c.reason, invoice: redact(e.bolt11) };
  }),
}, null, 2));

const applyIdx = Deno.args.indexOf("--apply");
if (applyIdx >= 0) {
  const truthPath = Deno.args[applyIdx + 1];
  if (!truthPath) {
    console.error("--apply needs a truth file: {\"<quoteId>\": {\"truth\":\"settled\",\"preimage\":\"...\"}}");
    Deno.exit(2);
  }
  const truth = JSON.parse(await Deno.readTextFile(truthPath)) as Record<string, { truth: "settled" | "failed" | "unknown"; preimage?: string }>;
  const out = raw.map((e) => {
    const t = truth[String(e.quoteId ?? "")];
    return t ? applyWalletTruth(e, t.truth, t.preimage) : e;
  });
  await Deno.writeTextFile(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ applied: Object.keys(truth).length, journal: path }));
} else {
  console.log(JSON.stringify({ note: "READ-ONLY. Nothing written. Pass --apply <truth.json> once the wallet has been asked." }));
}
