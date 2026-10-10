// Lifecycle for the throwaway OpenAI account rail — PLAN-0008.
//
// PURITY CONTRACT: this file has no network, no clock, no filesystem and no
// randomness. Every side effect lives behind the rail interface in `rail.ts`.
// That is what makes the whole provisioning run testable without an account,
// a card, or a single cent — which is the entire reason this service is
// deferred rather than driven by hand.
//
// The state machine is deliberately tiny and total: an explicit allow-list of
// transitions, a terminal `abandoned` state that acts as the kill switch, and
// a human-action note attached to every edge that needs a person.

export type AccountState =
  | "requested"
  | "email_verified"
  | "payment_pending"
  | "funded"
  | "charge_verified"
  | "active"
  | "abandoned";

/** Insertion order is the happy path. `abandoned` is reachable from anywhere. */
export const HAPPY_PATH: readonly AccountState[] = [
  "requested",
  "email_verified",
  "payment_pending",
  "funded",
  "charge_verified",
  "active",
] as const;

const ALLOWED: Record<AccountState, readonly AccountState[]> = {
  requested: ["email_verified", "abandoned"],
  email_verified: ["payment_pending", "abandoned"],
  payment_pending: ["funded", "abandoned"],
  funded: ["charge_verified", "abandoned"],
  charge_verified: ["active", "abandoned"],
  active: ["abandoned"],
  // KILL SWITCH: terminal. Nothing may leave `abandoned`, ever. A rail whose
  // operator accepted a ban risk must not be resurrectable by a later step.
  abandoned: [],
};

/**
 * The human-in-the-loop note for an edge, or null when the step is mechanical.
 *
 * These are the steps that must NOT be automated: captcha solving and identity
 * checks are exactly what turns an accepted ToS risk into a fraud signal, and
 * they would get the account banned before it is ever useful (PLAN-0008 D5).
 */
const HUMAN_STEPS: Readonly<Record<string, string>> = {
  "requested->email_verified":
    "Solve the signup captcha and complete email/OTP verification by hand.",
  "email_verified->payment_pending":
    "Buy the 2fiat FLARE card and attach it. Flare ONLY — it is the one card whose own copy supports OpenAI billing.",
  "payment_pending->funded":
    "Confirm the card shows the ~$5 top-up before charging.",
  "funded->charge_verified":
    "THE SINGLE LIVE CHARGE: smallest billable OpenAI amount. Copy the vendor's response verbatim.",
  "charge_verified->active":
    "Record the outcome against the acceptance criteria in PLAN-0008.",
};

const edge = (from: AccountState, to: AccountState): string => `${from}->${to}`;

export function isTerminal(state: AccountState): boolean {
  return ALLOWED[state].length === 0;
}

export function nextStates(state: AccountState): readonly AccountState[] {
  return ALLOWED[state];
}

export function canAdvance(from: AccountState, to: AccountState): boolean {
  return ALLOWED[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(from: AccountState, to: AccountState) {
    super(
      `illegal transition ${edge(from, to)}: from ${from} allowed -> ${
        ALLOWED[from].join(", ") || "(terminal)"
      }`,
    );
    this.name = "IllegalTransition";
  }
}

/** Advance one step. Throws `IllegalTransition` rather than silently no-op'ing. */
export function advance(from: AccountState, to: AccountState): AccountState {
  if (!canAdvance(from, to)) throw new IllegalTransition(from, to);
  return to;
}

/** The human action required for an edge, or null when it is mechanical. */
export function humanStep(from: AccountState, to: AccountState): string | null {
  if (!canAdvance(from, to)) throw new IllegalTransition(from, to);
  return HUMAN_STEPS[edge(from, to)] ?? null;
}

/** Remaining human actions from a given state along the happy path. */
export function remainingHumanSteps(from: AccountState): { to: AccountState; note: string }[] {
  if (isTerminal(from)) return [];
  const out: { to: AccountState; note: string }[] = [];
  let cur: AccountState | undefined = from;
  while (cur !== undefined) {
    const candidates: readonly AccountState[] = ALLOWED[cur].filter((s) => s !== "abandoned");
    const nxt: AccountState | undefined = candidates[0];
    if (nxt === undefined) break;
    const note = HUMAN_STEPS[edge(cur, nxt)];
    if (note) out.push({ to: nxt, note });
    cur = nxt;
  }
  return out;
}

// =====================================================================
// OUTCOME INTERPRETATION — decided BEFORE the run, per PLAN-0008
// =====================================================================

export type ChargeOutcome =
  | "approved"
  | "declined_card"
  | "declined_account"
  | "banned"
  | "inconclusive";

export interface Verdict {
  /** Terminal state this outcome drives the lifecycle to. */
  state: AccountState;
  /** What the result means for the open question. */
  meaning: string;
  /** True when a repeat attempt is authorised. Deliberately rare. */
  mayRetry: boolean;
}

/**
 * Map a measured charge outcome to a verdict.
 *
 * These mappings are the acceptance criteria from PLAN-0008 and are fixed
 * BEFORE the charge, so the result cannot be rationalised after the fact.
 */
export const OUTCOME_VERDICTS: Readonly<Record<ChargeOutcome, Verdict>> = {
  approved: {
    state: "charge_verified",
    meaning: "PROVEN: a 2fiat Flare card funds OpenAI. The 2fiat-funded path is real.",
    mayRetry: false,
  },
  declined_card: {
    state: "abandoned",
    meaning:
      "REFUTED FOR FLARE: Flare's copy is aspirational. This does NOT re-imply the vendor-wide 'no'.",
    mayRetry: false,
  },
  declined_account: {
    state: "abandoned",
    meaning:
      "INCONCLUSIVE about Flare — the account is the problem, not the card. Retry once, then stop.",
    mayRetry: true,
  },
  banned: {
    state: "abandoned",
    meaning: "ACCEPTED OUTCOME (D1): a ban is a result, not a failure. Record it and stop.",
    mayRetry: false,
  },
  inconclusive: {
    state: "abandoned",
    meaning: "INCONCLUSIVE: do not buy a second card to chase this.",
    mayRetry: false,
  },
};

export function interpret(outcome: ChargeOutcome): Verdict {
  return OUTCOME_VERDICTS[outcome];
}

/** The one-line plan, for `account_plan`. No side effects. */
export function planSummary(): string {
  return [
    "PLAN-0008: throwaway OpenAI account -> 2fiat FLARE card -> ONE live charge.",
    "Question: can a 2fiat-funded card pay an OpenAI bill?",
    "Flare ONLY. Never the operator's real account. Internal use only; ban accepted.",
    `Human steps remaining from 'requested': ${remainingHumanSteps("requested").length}.`,
  ].join(" ");
}
