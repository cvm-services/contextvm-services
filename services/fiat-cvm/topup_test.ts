// R3 — the MISSING LINK: `topup`.
//
// The CVM exposed cards/quote/pay/status. There was no way to put money ON a card,
// so the chain the product needs was incomplete:
//
//     customer sats -> melt -> ??? -> card pays the venue
//
// The top-up contract was measured during recon but never implemented:
//   POST /api/v1/prepaid-cards/topup/{cardId}/check-availability
//        {"topupValue":"N"}                          -> availability
//   POST /api/v1/prepaid-cards/topup/{cardId}
//        {"topupValue":"N","selectedMethod":"BTC-LN"} -> {amount, checkoutLink, checkout}
//   fee 6.5%, carried in the card product's metadata (topup_fee).
//
// Money-safety rules for this tool, mirroring the melt work:
//   * it NEVER claims a card is funded — it returns an INVOICE to be paid;
//   * funding is only true when the CARD BALANCE moves, which is `status`'s job;
//   * the amount charged is the fee-inclusive figure from 2fiat, and if that
//     disagrees with our own quote we say so rather than trusting one silently;
//   * a returned checkoutLink that is not a bolt11 is an error, not a payment.

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { FiatClient, FiatError } from "./fiat_client.ts";
import { topupFiat, TOPUP_TOOL } from "./tools.ts";

const CARD = {
  id: "1ca031655b5d4c74a35e090b7979f7df",
  masked_number: "5257 **** **** 9166",
  expiry: "08/27",
  alias: "ailaptop-not-doxed",
  payment_type: "mc",
  balance: 0.38,
  currency: "USD",
  topup_fee: 0.065,
};

// `cards()` first establishes a session (POST auth/exchange) and then reads
// `{ data: [...] }`. The session call is honoured here so the fixture matches the
// real client rather than a guess.
function clientWith(handler: (url: string, init?: RequestInit) => Response) {
  return new FiatClient({
    token: "t".repeat(38),
    baseUrl: "https://2fiat.test",
    fetchImpl: ((u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("auth/exchange")) {
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(handler(url, init));
    }) as typeof fetch,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.test("topup returns an INVOICE — it never claims the card is funded", async () => {
  const seen: string[] = [];
  const c = clientWith((url) => {
    seen.push(url);
    if (url.endsWith("/cards")) return json({ data: [CARD] });
    return json({
      amount: "10.65",
      checkoutLink: "lnbc10650n1p4abcdef",
      checkout: { defaultPaymentMethod: "BTC-LN" },
    });
  });

  const r = await topupFiat(c, { amount: 10 });

  assertEquals(r.kind, "invoice");
  assertEquals(r.bolt11, "lnbc10650n1p4abcdef");
  assertEquals(r.chargedAmount, 10.65);
  // The tool must be explicit that nothing has been paid yet.
  assertStringIncludes(r.note.toLowerCase(), "not funded");
  assertEquals(r.cardId, CARD.id);
});

Deno.test("the charged amount is the fee-inclusive figure the provider returns", async () => {
  const c = clientWith((url) => {
    if (url.endsWith("/cards")) return json({ data: [CARD] });
    return json({ amount: "10.65", checkoutLink: "lnbc1x", checkout: {} });
  });
  const r = await topupFiat(c, { amount: 10 });
  // 10 + 6.5% = 10.65, and the provider's own number is authoritative.
  assertEquals(r.chargedAmount, 10.65);
  assertEquals(r.fee, 0.65);
});

Deno.test("a provider amount that disagrees with our quote is surfaced, not swallowed", async () => {
  const c = clientWith((url) => {
    if (url.endsWith("/cards")) return json({ data: [CARD] });
    // Provider says 11.20 where 6.5% implies 10.65.
    return json({ amount: "11.20", checkoutLink: "lnbc1x", checkout: {} });
  });
  const r = await topupFiat(c, { amount: 10 });
  assertEquals(r.chargedAmount, 11.2);
  assertStringIncludes(String(r.feeDiscrepancy ?? ""), "discrepan");
});

Deno.test("a non-bolt11 checkoutLink is an ERROR, not a payment", async () => {
  const c = clientWith((url) => {
    if (url.endsWith("/cards")) return json({ data: [CARD] });
    return json({ amount: "10.65", checkoutLink: "https://2fiat.example/pay/i/123", checkout: {} });
  });
  await assertRejects(() => topupFiat(c, { amount: 10 }), FiatError);
});

Deno.test("an unknown card id is refused before any network write", async () => {
  let wrote = false;
  const c = clientWith((url, init) => {
    if (url.endsWith("/cards")) return json({ data: [CARD] });
    if (init?.method === "POST") wrote = true;
    return json({});
  });
  await assertRejects(() => topupFiat(c, { amount: 10, card_id: "nope" }), FiatError);
  assertEquals(wrote, false, "must not POST a top-up for a card we cannot see");
});

Deno.test("the tool is ADVERTISED, so a client can discover it", () => {
  assertEquals(TOPUP_TOOL.name, "topup");
  assertEquals(TOPUP_TOOL.inputSchema.required, ["amount"]);
});
