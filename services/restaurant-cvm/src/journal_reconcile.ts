/**
 * Treasury journal reconciliation.
 *
 * The journal is the only record of what was spent, so an entry that never
 * reached a terminal state means the answer to "what did we spend?" is unknown -
 * which is the failure this whole workstream exists to eliminate.
 *
 * THE RULE HERE: no state is invented. An entry is only called `settled` when it
 * carries a VALID preimage (32 bytes, 64 hex chars), or when the wallet confirms
 * it. Everything else stays `unknown` and is surfaced loudly. Marking a stuck
 * entry "failed" would be the same class of lie as marking a timeout "failed" in
 * the settlement core: it invites a retry of something that may already have
 * happened.
 */

export type EntryKind = "settled" | "unverified_claim" | "unknown" | "malformed";

export interface JournalEntry {
  amountSats?: number;
  bolt11?: string;
  preimage?: string;
  proofs?: unknown[];
  quoteId?: string;
  startedAt?: number;
  state?: string;
}

export interface Classification {
  kind: EntryKind;
  /** Safe to print. No preimage, no invoice body. */
  reason: string;
  sats: number;
  quote_id: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** A preimage is the only self-contained proof of settlement. */
export function isValidPreimage(p: unknown): boolean {
  return typeof p === "string" && HEX64.test(p.trim());
}

export function classifyEntry(e: JournalEntry): Classification {
  const sats = Number(e.amountSats ?? 0);
  const quote_id = String(e.quoteId ?? "(none)");

  if (!e.bolt11 || String(e.bolt11).trim().length < 100) {
    return { kind: "malformed", reason: "no usable invoice", sats, quote_id };
  }

  if (isValidPreimage(e.preimage)) {
    return { kind: "settled", reason: "valid preimage", sats, quote_id };
  }

  if (e.state === "claimed" || e.state === "paid") {
    // Claims settlement without the proof that makes it checkable.
    const len = typeof e.preimage === "string" ? e.preimage.length : 0;
    return {
      kind: "unverified_claim",
      reason: e.preimage
        ? `state=${e.state} but preimage is malformed (${len} chars, expected 64 hex)`
        : `state=${e.state} with no preimage at all`,
      sats,
      quote_id,
    };
  }

  if (e.state === "paying" || e.state === "paying...") {
    return {
      kind: "unknown",
      reason: "stuck in paying: outcome never recorded",
      sats,
      quote_id,
    };
  }

  return { kind: "unknown", reason: `unhandled state "${e.state ?? "none"}"`, sats, quote_id };
}

export interface ReconciliationSummary {
  total_entries: number;
  settled_sats: number;
  unknown_sats: number;
  unverified_sats: number;
  /** What must be asked of the wallet: invoices whose fate is not established. */
  needs_wallet_lookup: Classification[];
  clean: boolean;
}

export function summarise(entries: JournalEntry[]): ReconciliationSummary {
  let settled_sats = 0;
  let unknown_sats = 0;
  let unverified_sats = 0;
  const needs_wallet_lookup: Classification[] = [];

  for (const e of entries) {
    const c = classifyEntry(e);
    if (c.kind === "settled") settled_sats += c.sats;
    else if (c.kind === "unknown") { unknown_sats += c.sats; needs_wallet_lookup.push(c); }
    else if (c.kind === "unverified_claim") { unverified_sats += c.sats; needs_wallet_lookup.push(c); }
    else needs_wallet_lookup.push(c);
  }

  return {
    total_entries: entries.length,
    settled_sats,
    unknown_sats,
    unverified_sats,
    needs_wallet_lookup,
    // Clean means every sat has a proof AND no entry needs asking about.
    clean: needs_wallet_lookup.length === 0,
  };
}

/**
 * Apply wallet evidence to one entry. `truth` must come from the rail, never
 * from a guess. Returns a NEW entry; the caller decides whether to persist.
 */
export function applyWalletTruth(
  e: JournalEntry,
  truth: "settled" | "failed" | "unknown",
  preimage?: string,
): JournalEntry {
  if (truth === "unknown") {
    return { ...e, state: "outcome_unknown" };
  }
  if (truth === "failed") {
    return { ...e, state: "failed" };
  }
  // Settled: only accept it WITH a valid preimage. A wallet that says "settled"
  // without one leaves the entry unverified rather than silently trusted.
  if (!isValidPreimage(preimage)) {
    return { ...e, state: "settled_unverified" };
  }
  return { ...e, state: "settled", preimage };
}
