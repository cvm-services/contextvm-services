// Tests are the spec for the PLAN-0008 lifecycle.
//
// These run with no network, no account, no card and no money:
//   deno test --allow-read
// If one fails, the contract changed — read this file before changing it.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  advance,
  type AccountState,
  canAdvance,
  HAPPY_PATH,
  humanStep,
  IllegalTransition,
  interpret,
  isTerminal,
  nextStates,
  planSummary,
  remainingHumanSteps,
} from "./lifecycle.ts";

Deno.test("happy path is fully walkable, one step at a time", () => {
  let state: AccountState = HAPPY_PATH[0];
  for (const expected of HAPPY_PATH.slice(1)) {
    assertEquals(advance(state, expected), expected);
    state = expected;
  }
  assertEquals(state, "active");
});

Deno.test("every happy-path edge is allowed and no edge is missing", () => {
  for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
    const from = HAPPY_PATH[i];
    const to = HAPPY_PATH[i + 1];
    assertEquals(canAdvance(from, to), true, `${from} -> ${to} must be allowed`);
  }
});

Deno.test("state cannot be jumped — one step at a time only", () => {
  // Skipping verification or payment must be impossible, not merely discouraged.
  assertThrows(() => advance("requested", "funded"), IllegalTransition);
  assertThrows(() => advance("requested", "active"), IllegalTransition);
  assertThrows(() => advance("email_verified", "charge_verified"), IllegalTransition);
  assertThrows(() => advance("payment_pending", "active"), IllegalTransition);
});

Deno.test("backwards transitions are refused", () => {
  assertThrows(() => advance("funded", "requested"), IllegalTransition);
  assertThrows(() => advance("active", "funded"), IllegalTransition);
});

Deno.test("abandoned is the kill switch: terminal, and nothing escapes it", () => {
  assertEquals(isTerminal("abandoned"), true);
  assertEquals(nextStates("abandoned"), []);
  assertEquals(remainingHumanSteps("abandoned"), []);
  for (const s of HAPPY_PATH) {
    assertThrows(() => advance("abandoned", s), IllegalTransition);
  }
});

Deno.test("abandoned is reachable from every live state", () => {
  for (const s of HAPPY_PATH) {
    assertEquals(canAdvance(s, "abandoned"), true, `${s} must be abandonable`);
  }
});

Deno.test("only the last state is terminal among the happy path", () => {
  assertEquals(isTerminal("active"), false, "active may still be abandoned");
  for (const s of HAPPY_PATH) {
    assertEquals(isTerminal(s), false, `${s} must not be terminal`);
  }
});

Deno.test("captcha and OTP step is flagged for a human", () => {
  const note = humanStep("requested", "email_verified");
  assertEquals(typeof note, "string");
  assertEquals((note ?? "").toLowerCase().includes("captcha"), true);
});

Deno.test("the card step names Flare explicitly and forbids generalising", () => {
  const note = humanStep("email_verified", "payment_pending") ?? "";
  assertEquals(note.includes("FLARE") || note.includes("Flare"), true);
  assertEquals(note.includes("ONLY"), true);
});

Deno.test("the charge step demands a verbatim vendor response", () => {
  const note = humanStep("funded", "charge_verified") ?? "";
  assertEquals(note.toLowerCase().includes("verbatim"), true);
  assertEquals(note.toLowerCase().includes("single"), true);
});

Deno.test("a mechanical edge reports no human step rather than an empty string", () => {
  // `active -> abandoned` needs no operator action.
  assertEquals(humanStep("active", "abandoned"), null);
});

Deno.test("humanStep refuses on an illegal edge instead of returning null", () => {
  assertThrows(() => humanStep("requested", "funded"), IllegalTransition);
});

Deno.test("remaining human steps from 'requested' covers the whole run", () => {
  const steps = remainingHumanSteps("requested");
  assertEquals(steps.length, HAPPY_PATH.length - 1, "one human note per happy-path edge");
  assertEquals(steps[0].to, "email_verified");
  assertEquals(steps.at(-1)?.to, "active");
});

Deno.test("interpret maps every outcome to a decided verdict", () => {
  assertEquals(interpret("approved").state, "charge_verified");
  assertEquals(interpret("declined_card").state, "abandoned");
  assertEquals(interpret("declined_account").state, "abandoned");
  assertEquals(interpret("banned").state, "abandoned");
  assertEquals(interpret("inconclusive").state, "abandoned");
});

Deno.test("only an account-level decline authorises a retry", () => {
  // A card-level decline is a real answer; retrying it would just spend money.
  const retryable = (["approved", "declined_card", "declined_account", "banned", "inconclusive"] as const)
    .filter((o) => interpret(o).mayRetry);
  assertEquals(retryable, ["declined_account"]);
});

Deno.test("a card-level decline must not be reported as a vendor-wide answer", () => {
  const v = interpret("declined_card");
  assertEquals(v.meaning.toUpperCase().includes("DOES NOT"), true);
  assertEquals(v.meaning.toUpperCase().includes("FLARE"), true);
});

Deno.test("a ban is described as a result, not a failure", () => {
  const m = interpret("banned").meaning.toLowerCase();
  assertEquals(m.includes("result"), true);
  assertEquals(m.includes("accepted outcome"), true);
});

Deno.test("planSummary states the question, the card and the guardrails", () => {
  const s = planSummary();
  assertEquals(s.includes("FLARE"), true);
  assertEquals(s.includes("throwaway"), true);
  assertEquals(s.toLowerCase().includes("ban accepted"), true);
});
