// Tool-surface tests for the PLAN-0008 rail. No network, no relay, no account.
//   deno test --allow-read

import { assertEquals } from "jsr:@std/assert@1";
import { accountAdvance, accountCharge, handleMcpMessage, handleToolCall, TOOLS } from "./service.ts";

Deno.test("tools/list advertises all four tools", () => {
  const res = handleMcpMessage({ method: "tools/list" }) as { tools: readonly { name: string }[] };
  assertEquals(res.tools.map((t) => t.name).sort(), [
    "account_advance",
    "account_charge",
    "account_plan",
    "account_status",
  ]);
});

Deno.test("account_plan is side-effect free and names Flare", () => {
  const r = handleToolCall("account_plan");
  assertEquals(r.ok, true);
  assertEquals(r.state, "requested");
  assertEquals(r.text?.includes("FLARE"), true);
});

Deno.test("account_advance walks one legal step and reports the human action", () => {
  const r = accountAdvance("requested", "email_verified");
  assertEquals(r.ok, true);
  assertEquals(r.state, "email_verified");
  assertEquals((r.human_action ?? "").toLowerCase().includes("captcha"), true);
});

Deno.test("account_advance refuses to jump states", () => {
  const r = accountAdvance("requested", "funded");
  assertEquals(r.ok, false);
  assertEquals(r.error?.includes("illegal transition"), true);
});

Deno.test("account_advance cannot leave 'abandoned'", () => {
  for (const s of ["email_verified", "funded", "active"]) {
    const r = accountAdvance("abandoned", s);
    assertEquals(r.ok, false, `abandoned -> ${s} must be refused`);
  }
});

Deno.test("account_advance rejects unknown states instead of coercing", () => {
  assertEquals(accountAdvance("nope", "funded").ok, false);
  assertEquals(accountAdvance("requested", "done").ok, false);
  assertEquals(accountAdvance(undefined, undefined).ok, false);
});

Deno.test("a charge may only be recorded from 'funded'", () => {
  // Guards the ordering that makes the single live charge meaningful.
  const early = accountCharge("requested", "approved");
  assertEquals(early.ok, false);
  assertEquals(early.error?.includes("funded"), true);

  const atFunded = accountCharge("funded", "approved");
  assertEquals(atFunded.ok, true);
  assertEquals(atFunded.state, "charge_verified");
});

Deno.test("an approved charge advances toward activation, not abandonment", () => {
  const r = accountCharge("funded", "approved");
  assertEquals(r.state, "charge_verified");
  assertEquals(r.text?.includes("PROVEN"), true);
});

Deno.test("a card-level decline is terminal and unauthorised for retry", () => {
  const r = accountCharge("funded", "declined_card");
  assertEquals(r.state, "abandoned");
  assertEquals(r.text?.includes("no retry"), true);
  assertEquals(r.text?.toUpperCase().includes("FLARE"), true);
});

Deno.test("only an account-level decline authorises one retry", () => {
  const r = accountCharge("funded", "declined_account");
  assertEquals(r.state, "abandoned");
  assertEquals(r.text?.includes("one retry authorised"), true);
});

Deno.test("a ban is routed to abandoned and recorded as an accepted outcome", () => {
  const r = accountCharge("funded", "banned");
  assertEquals(r.state, "abandoned");
  assertEquals(r.text?.toLowerCase().includes("accepted outcome"), true);
});

Deno.test("a full run through the MCP envelope reaches 'active'", () => {
  const path: [string, string][] = [
    ["requested", "email_verified"],
    ["email_verified", "payment_pending"],
    ["payment_pending", "funded"],
  ];
  for (const [from, to] of path) {
    const res = handleMcpMessage({ method: "tools/call", params: { name: "account_advance", arguments: { from, to } } }) as { ok: boolean };
    assertEquals(res.ok, true, `${from} -> ${to}`);
  }
  const charged = handleMcpMessage({
    method: "tools/call",
    params: { name: "account_charge", arguments: { state: "funded", outcome: "approved" } },
  }) as { state?: string };
  assertEquals(charged.state, "charge_verified");

  const done = handleMcpMessage({
    method: "tools/call",
    params: { name: "account_advance", arguments: { from: "charge_verified", to: "active" } },
  }) as { state?: string };
  assertEquals(done.state, "active");
});

Deno.test("unknown tool and unknown method fail loudly, not silently", () => {
  const t = handleToolCall("account_teleport");
  assertEquals(t.ok, false);
  assertEquals(t.error?.includes("unknown tool"), true);

  const m = handleMcpMessage({ method: "resources/list" }) as { error?: string };
  assertEquals(m.error?.includes("unsupported method"), true);
});

Deno.test("every advertised tool has a name and a schema", () => {
  for (const t of TOOLS) {
    assertEquals(t.name.length > 0, true);
    assertEquals(typeof t.inputSchema, "object");
  }
});
