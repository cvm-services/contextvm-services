// CVM tool surface for the throwaway-OpenAI-account rail — PLAN-0008.
//
// Mirrors the shape of services/restaurant-cvm/server.ts: a pure `handleToolCall`
// plus a minimal MCP envelope, so the whole surface is testable with no relay,
// no account and no card.
//
// STATE IS NOT STORED HERE. v1 keeps no database and writes nothing: the caller
// carries the lifecycle state between calls. That is deliberate — a service that
// accepted a ban risk (PLAN-0008 D1) should not also be accumulating its own
// persistent record of the attempt.
//
// NOT IMPLEMENTED IN v1 (see PLAN-0008): relay connection, the 2fiat card rail,
// and any browser automation. `account_advance` returns what a human must do;
// it does not do it.

import {
  advance,
  type AccountState,
  type ChargeOutcome,
  humanStep,
  IllegalTransition,
  interpret,
  isTerminal,
  nextStates,
  planSummary,
  remainingHumanSteps,
} from "./lifecycle.ts";

export interface ToolResult {
  ok: boolean;
  state?: AccountState;
  next_states?: readonly AccountState[];
  human_action?: string | null;
  text?: string;
  error?: string;
}

export const TOOLS = [
  {
    name: "account_plan",
    description:
      "PLAN-0008 provisioning plan and remaining human steps. Side-effect free — call before anything is created.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "account_status",
    description: "Current lifecycle state, next legal states, and whether the run is terminal.",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string" } },
      required: ["state"],
      additionalProperties: false,
    },
  },
  {
    name: "account_advance",
    description:
      "Advance the lifecycle by exactly one legal step. Refuses to jump states and refuses to leave 'abandoned'.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "account_charge",
    description:
      "Record the single live charge outcome and return the decided verdict (PLAN-0008 acceptance criteria, fixed before the run).",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        outcome: { type: "string" },
      },
      required: ["state", "outcome"],
      additionalProperties: false,
    },
  },
] as const;

const STATES: readonly AccountState[] = [
  "requested",
  "email_verified",
  "payment_pending",
  "funded",
  "charge_verified",
  "active",
  "abandoned",
];

const OUTCOMES: readonly ChargeOutcome[] = [
  "approved",
  "declined_card",
  "declined_account",
  "banned",
  "inconclusive",
];

function asState(v: unknown): AccountState | null {
  return typeof v === "string" && (STATES as readonly string[]).includes(v)
    ? (v as AccountState)
    : null;
}

function asOutcome(v: unknown): ChargeOutcome | null {
  return typeof v === "string" && (OUTCOMES as readonly string[]).includes(v)
    ? (v as ChargeOutcome)
    : null;
}

export function accountPlan(): ToolResult {
  return {
    ok: true,
    state: "requested",
    next_states: nextStates("requested"),
    human_action: humanStep("requested", "email_verified"),
    text: `${planSummary()} Human steps: ${remainingHumanSteps("requested").length}.`,
  };
}

export function accountStatus(state: AccountState): ToolResult {
  return {
    ok: true,
    state,
    next_states: nextStates(state),
    human_action:
      nextStates(state).filter((s) => s !== "abandoned").map((s) => humanStep(state, s))[0] ?? null,
    text: isTerminal(state)
      ? `${state} is terminal — the run is over and cannot be resumed.`
      : `${state}. Next: ${nextStates(state).join(", ")}.`,
  };
}

export function accountAdvance(from: unknown, to: unknown): ToolResult {
  const f = asState(from);
  const t = asState(to);
  if (!f || !t) return { ok: false, error: `unknown state (from=${from}, to=${to})` };
  try {
    const state = advance(f, t);
    return {
      ok: true,
      state,
      next_states: nextStates(state),
      human_action: humanStep(f, t),
      text: `advanced ${f} -> ${state}`,
    };
  } catch (e) {
    if (e instanceof IllegalTransition) return { ok: false, error: e.message };
    throw e;
  }
}

export function accountCharge(state: unknown, outcome: unknown): ToolResult {
  const s = asState(state);
  const o = asOutcome(outcome);
  if (!s || !o) return { ok: false, error: `unknown state/outcome (${state}, ${outcome})` };
  if (s !== "funded") {
    return { ok: false, error: `a charge may only be recorded from 'funded', not '${s}'` };
  }
  const verdict = interpret(o);
  return {
    ok: true,
    state: verdict.state,
    next_states: nextStates(verdict.state),
    human_action: null,
    text: `${verdict.meaning}${verdict.mayRetry ? " (one retry authorised)" : " (no retry)"}`,
  };
}

export function handleToolCall(name: string, args: Record<string, unknown> = {}): ToolResult {
  switch (name) {
    case "account_plan":
      return accountPlan();
    case "account_status":
      return accountStatus(asState(args.state) ?? "requested");
    case "account_advance":
      return accountAdvance(args.from, args.to);
    case "account_charge":
      return accountCharge(args.state, args.outcome);
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

/** Minimal MCP envelope: tools/list and tools/call, nothing else. */
export function handleMcpMessage(msg: { method?: string; params?: Record<string, unknown> }): unknown {
  switch (msg.method) {
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      return handleToolCall(name, args);
    }
    default:
      return { error: `unsupported method: ${msg.method}` };
  }
}
