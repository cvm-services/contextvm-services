import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FiatClient } from "./fiat_client.ts";
import { callFiatTool, FIAT_TOOLS, payFiat, statusFiat } from "./tools.ts";

const TOKEN = "token1testonlynotarealtoken";

function withCards(cards: unknown[]) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return Promise.resolve(new Response(JSON.stringify(cards), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }) as unknown as typeof fetch;
  return { client: new FiatClient({ token: TOKEN, fetchImpl: fn }), seen };
}

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
const POOR = { ...RICH, id: "poor", balance: 0.38, cardNumber: "5257 **** **** 4886" };

Deno.test("every tool declares a name, a description and an input schema", () => {
  assertEquals(FIAT_TOOLS.length, 5, "cards/quote/topup/pay/status — topup is the funding link");
  for (const t of FIAT_TOOLS) {
    if (!t.name || !t.description) throw new Error(`tool ${JSON.stringify(t)} is incomplete`);
    assertEquals(t.inputSchema.type, "object");
  }
  assertEquals(FIAT_TOOLS.map((t) => t.name), ["cards", "topup", "quote", "pay", "status"]);
});

Deno.test("pay NEVER reports captured while the capture call is unwired", async () => {
  const { client } = withCards([RICH]);
  const r = await payFiat(client, { amount: 10, venue_slug: "ristorante-matera-berlin" });
  if (r.state === "captured") {
    throw new Error("paid claimed without an observed capture — the exact failure this guard exists for");
  }
  assertEquals(r.state, "requires_3ds");
  assertEquals(r.reference, null);
  assertEquals(r.card_id, "rich");
  assertEquals(r.amount, 10.65); // 10 + 6.5% fee
  if (!r.detail) throw new Error("a non-captured result must explain itself");
});

Deno.test("pay explains the MEASURED reason, and does not blame 3DS", async () => {
  // Measured 2026-10-18 with NO charge attempted:
  //   POST prepaid-cards/pay                -> 404 product_not_found
  //     (it resolves a card PRODUCT to buy, not a charge on an existing card)
  //   POST prepaid-cards/details/{id}       -> 200 {cardNumber, cvv, expirationDate}
  //   GET  prepaid-cards/details/{id}/otp   -> 200   <- the OTP is API-retrievable
  //
  // So "3D-Secure-gated upstream" is FALSE: 3DS is not what blocks us. What blocks us
  // is that the provider exposes card VALUES and no charge-by-reference endpoint.
  // A user-facing reason that names the wrong cause sends the next engineer to the
  // wrong place — exactly the mistake that cost this project several rounds.
  const { client } = withCards([RICH]);
  const r = await payFiat(client, { amount: 10, venue_slug: "ristorante-matera-berlin" });
  const detail = (r.detail ?? "").toLowerCase();

  if (detail.includes("3d-secure") || detail.includes("3ds")) {
    throw new Error(
      `pay blames 3DS, but the OTP is API-retrievable (measured GET .../details/{id}/otp -> 200). ` +
        `The real cause is: no charge-by-reference endpoint; card values required. Got: ${r.detail}`,
    );
  }
  // It must name the actual mechanism.
  if (!detail.includes("reference") && !detail.includes("card values")) {
    throw new Error(`pay must state the measured reason (no reference / card values). Got: ${r.detail}`);
  }
});

Deno.test("a real-wallet balance level declines an ordinary venue charge", async () => {
  // The live wallet's cards hold 0.38 and 0.30 USD. An honest pay must decline
  // a normal meal rather than pretend it went through.
  const { client } = withCards([{ ...POOR, balance: 0.38 }]);
  const r = await payFiat(client, { amount: 29 });
  assertEquals(r.state, "declined");
  assertEquals(r.reference, null);
  if (!/below the fee-inclusive total/.test(String(r.detail))) {
    throw new Error(`decline reason should name the shortfall, got: ${r.detail}`);
  }
});

Deno.test("pay declines when the card cannot cover the fee-inclusive total", async () => {
  const { client } = withCards([POOR]);
  const r = await payFiat(client, { amount: 29 });
  assertEquals(r.state, "declined");
  assertEquals(r.reference, null);
  if (!/below the fee-inclusive total/.test(String(r.detail))) {
    throw new Error(`decline reason should name the shortfall, got: ${r.detail}`);
  }
});

Deno.test("pay refuses a non-positive amount instead of guessing", async () => {
  const { client } = withCards([RICH]);
  await assertRejects(() => payFiat(client, { amount: 0 }));
  await assertRejects(() => payFiat(client, { amount: -5 }));
  await assertRejects(() => payFiat(client, { amount: Number.NaN }));
});

Deno.test("status corroborates only against an observed balance", async () => {
  const { client } = withCards([RICH]);
  const s = await statusFiat(client, "rich", 20);
  assertEquals(s.corroborated, false, "20 is not below 20");
  const s2 = await statusFiat(client, "rich");
  assertEquals(s2.corroborated, null, "no baseline means no claim");
  await assertRejects(() => statusFiat(client, "nope"));
});

Deno.test("callFiatTool dispatches all four tools and rejects an unknown one", async () => {
  const { client } = withCards([RICH, POOR]);
  const cards = await callFiatTool(client, "cards", {}) as { cards: unknown[] };
  assertEquals(cards.cards.length, 2);
  const q = await callFiatTool(client, "quote", { amount: 10 }) as { total: number; card_id: string };
  assertEquals(q.card_id, "rich");
  assertEquals(q.total, 10.65);
  const p = await callFiatTool(client, "pay", { amount: 10 }) as { state: string };
  assertEquals(p.state, "requires_3ds");
  await assertRejects(() => callFiatTool(client, "nope", {}));
});

Deno.test("no tool result carries a card number beyond the masked form", async () => {
  const { client } = withCards([RICH]);
  const r = await callFiatTool(client, "cards", {});
  const s = JSON.stringify(r);
  if (/5257\s*\d{4}\s*\d{4}\s*9166(?!.*\*)/.test(s) && !s.includes("****")) {
    throw new Error("unmasked card number in tool output");
  }
  if (!s.includes("5257 **** **** 9166")) {
    throw new Error("expected the masked form to be what is relayed");
  }
});
