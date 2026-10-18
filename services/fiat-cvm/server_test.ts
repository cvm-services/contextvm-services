import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FiatClient } from "./fiat_client.ts";
import { handleMcpMessage } from "./server.ts";

const RICH = {
  id: "rich",
  balance: 20,
  currency: "USD",
  cardNumber: "5257 **** **** 9166",
  expirationDate: "08/27",
  alias: "laptop",
  paymentType: "mc",
  cardProduct: { metadata: { topup_fee: 0.065 } },
};

function deps(allow: string[] = ["facilitator-pk"]) {
  const fn = (() =>
    Promise.resolve(new Response(JSON.stringify([RICH]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))) as unknown as typeof fetch;
  return {
    client: new FiatClient({ token: "token1testonlynotarealtoken", fetchImpl: fn }),
    payAllowlist: allow,
  };
}

Deno.test("initialize names the fiat server", async () => {
  const r = await handleMcpMessage(deps(), { method: "initialize", id: 1 });
  const info = (r?.result as { serverInfo: { name: string } }).serverInfo;
  assertEquals(info.name, "contextvm-2fiat-server");
});

Deno.test("tools/list exposes exactly the five fiat tools (cards/quote/topup/pay/status)", async () => {
  const r = await handleMcpMessage(deps(), { method: "tools/list", id: 2 });
  const names = (r?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assertEquals(names, ["cards", "topup", "quote", "pay", "status"]);
});

Deno.test("read tools need no allowlist", async () => {
  const r = await handleMcpMessage(deps([]), { method: "tools/call", id: 3, params: { name: "cards", arguments: {} } });
  const res = r?.result as { isError?: boolean; content: { text: string }[] };
  assertEquals(res.isError, undefined);
  if (!res.content[0].text.includes("5257 **** **** 9166")) {
    throw new Error("cards should return the masked number");
  }
});

Deno.test("pay is refused when no allowlist is configured (read-only service)", async () => {
  const r = await handleMcpMessage(deps([]), {
    method: "tools/call", id: 4, params: { name: "pay", arguments: { amount: 10 } },
  }, "anyone");
  const res = r?.result as { isError?: boolean; content: { text: string }[] };
  assertEquals(res.isError, true);
  if (!/disabled/.test(res.content[0].text)) throw new Error("expected a visible refusal");
});

Deno.test("pay is refused for a caller not on the allowlist", async () => {
  const r = await handleMcpMessage(deps(["facilitator-pk"]), {
    method: "tools/call", id: 5, params: { name: "pay", arguments: { amount: 10 } },
  }, "stranger-pk");
  const res = r?.result as { isError?: boolean; content: { text: string }[] };
  assertEquals(res.isError, true);
  if (!/not in the facilitator allowlist/.test(res.content[0].text)) {
    throw new Error("expected an allowlist refusal naming the caller");
  }
});

Deno.test("pay proceeds for an allowlisted caller and reports the honest state", async () => {
  const r = await handleMcpMessage(deps(["facilitator-pk"]), {
    method: "tools/call", id: 6, params: { name: "pay", arguments: { amount: 10 } },
  }, "facilitator-pk");
  const res = r?.result as { isError?: boolean; content: { text: string }[] };
  assertEquals(res.isError, undefined);
  const out = JSON.parse(res.content[0].text);
  assertEquals(out.state, "requires_3ds");
  assertEquals(out.reference, null);
});

Deno.test("a failing tool returns a visible error, never silence", async () => {
  const r = await handleMcpMessage(deps(), {
    method: "tools/call", id: 7, params: { name: "quote", arguments: { amount: -1 } },
  });
  const res = r?.result as { isError?: boolean; content: { text: string }[] };
  assertEquals(res.isError, true);
  if (!res.content[0].text.includes("failed")) throw new Error("expected a named failure");
});

Deno.test("an unknown method is a JSON-RPC error, not a hang", async () => {
  const r = await handleMcpMessage(deps(), { method: "nonsense", id: 8 });
  assertEquals(r?.error?.code, -32601);
});
