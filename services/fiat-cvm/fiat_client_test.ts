import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BROWSER_UA, FiatClient, FiatError, normaliseCard } from "./fiat_client.ts";

const TOKEN = "token1testonlynotarealtoken";

/** Records what the client sent, so we can assert the transport contract. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    for (const [needle, reply] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        }));
      }
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fn: fn as unknown as typeof fetch, seen };
}

Deno.test("every request carries a browser UA and the ngrok header (the edge drops non-browsers)", async () => {
  const { fn, seen } = stubFetch({ "/api/v1/auth/exchange": { body: { ok: true } }, "/api/v1/cards": { body: [] } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  await c.login();
  await c.cards();
  assertEquals(seen.length, 2);
  for (const s of seen) {
    const h = s.init?.headers as Record<string, string>;
    assertEquals(h["user-agent"], BROWSER_UA, "browser UA is a transport requirement");
    assertEquals(h["ngrok-skip-browser-warning"], "5000");
    assertEquals(h["content-type"], "application/json");
  }
});

Deno.test("login posts the token in the body, never in the URL", async () => {
  const { fn, seen } = stubFetch({ "auth/exchange": { body: {} } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  await c.login();
  const body = JSON.parse(String(seen[0].init?.body));
  assertEquals(body.token, TOKEN);
  assertEquals(body.nextPath, "/wallet/my-cards");
  // the secret must not be smeared into a URL that could end up in a log
  if (seen[0].url.includes(TOKEN)) throw new Error("token leaked into the request URL");
});

Deno.test("an empty token is refused at construction, not at first use", () => {
  assertThrows(() => new FiatClient({ token: "" }), FiatError);
});

Deno.test("cards are normalised: masked number kept, fee lifted from product metadata", () => {
  const card = normaliseCard({
    id: "abc",
    balance: 0.38,
    currency: "USD",
    cardNumber: "5257 **** **** 9166",
    expirationDate: "08/27",
    alias: "laptop",
    paymentType: "mc",
    cardProduct: { metadata: { topup_fee: 0.065 } },
  });
  assertEquals(card.id, "abc");
  assertEquals(card.masked_number, "5257 **** **** 9166");
  assertEquals(card.topup_fee, 0.065);
  assertEquals(card.balance, 0.38);
});

Deno.test("a failed exchange is a FiatError carrying the status", async () => {
  const { fn } = stubFetch({ "auth/exchange": { status: 401, body: { error: "Unauthorized" } } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  await assertRejects(() => c.login(), FiatError);
});

Deno.test("pickCard chooses by id, and the richest card when unspecified", () => {
  const c = new FiatClient({ token: TOKEN, fetchImpl: stubFetch({}).fn });
  const cards = [
    normaliseCard({ id: "poor", balance: 0.3, cardNumber: "5257 **** **** 4886" }),
    normaliseCard({ id: "rich", balance: 20, cardNumber: "5257 **** **** 9166" }),
  ];
  assertEquals(c.pickCard(cards, "poor").id, "poor");
  assertEquals(c.pickCard(cards).id, "rich");
  assertThrows(() => c.pickCard(cards, "nope"), FiatError);
  assertThrows(() => c.pickCard([]), FiatError);
});

Deno.test("quoteTotal applies the product's top-up fee and rounds to cents", () => {
  const c = new FiatClient({ token: TOKEN, fetchImpl: stubFetch({}).fn });
  const card = normaliseCard({ id: "x", balance: 5, cardProduct: { metadata: { topup_fee: 0.065 } } });
  const q = c.quoteTotal(card, 29);
  assertEquals(q.total, 30.89); // 29 + 6.5% = 30.885 → 30.89
  assertThrows(() => c.quoteTotal(card, 0), FiatError);
  assertThrows(() => c.quoteTotal(card, -1), FiatError);
});
