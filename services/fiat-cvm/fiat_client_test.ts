import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BROWSER_UA, FiatClient, FiatError, normaliseCard } from "./fiat_client.ts";

const TOKEN = "token1testonlynotarealtoken";

/** Records what the client sent, so we can assert the transport contract. */
function stubFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
  opts: { cookie?: string; onRequest?: (url: string, init?: RequestInit) => void } = {},
) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    opts.onRequest?.(url, init);
    for (const [needle, reply] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        // auth/exchange establishes the session cookie (fetch has no cookie jar)
        if (url.includes("auth/exchange")) headers["set-cookie"] = "SESSION=abc123; Path=/; HttpOnly";
        return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status ?? 200,
          headers,
        }));
      }
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fn: fn as unknown as typeof fetch, seen };
}

Deno.test("every request is bounded by a timeout — a blocked 2fiat must not hang the CVM", async () => {
  // Observed in production: 2fiat's edge timed out at the TCP level and the CVM
  // hung indefinitely instead of reporting an error, because fetch was called
  // with no signal. A hung tool call is worse than a failed one: the console
  // shows nothing and the operator cannot tell whether money moved.
  let sawSignal = false;
  const { fn } = stubFetch({ "auth/exchange": { body: {} }, "/api/v1/cards": { body: [] } }, {
    onRequest: (_url, init) => {
      if (init?.signal) sawSignal = true;
    },
  });
  const client = new FiatClient({ token: "token1abc", fetchImpl: fn, timeoutMs: 50 });
  await client.cards();
  assertEquals(sawSignal, true, "fetch must be called with an AbortSignal");
});

Deno.test("a request that never resolves fails loudly at the timeout, not silently", async () => {
  // A relay/server that accepts the connection and then says nothing.
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const client = new FiatClient({ token: "token1abc", fetchImpl: hanging, timeoutMs: 40 });
  let err: unknown = null;
  try {
    await client.login();
  } catch (e) {
    err = e;
  }
  assert(err instanceof FiatError, "must surface a FiatError, not hang");
  assert(String((err as Error).message).toLowerCase().includes("tim"), "the message must name the timeout");
});

Deno.test("cards() logs in first and carries the session cookie (no cookie jar in fetch)", async () => {
  const { fn, seen } = stubFetch({ "auth/exchange": { body: {} }, "/api/v1/cards": { body: [] } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  assertEquals(c.sessionEstablished, false);
  await c.cards();
  assertEquals(c.sessionEstablished, true, "cards() must establish the session");
  assertEquals(seen.length, 2, "exchange then cards");
  const cardsCall = seen[seen.length - 1];
  const h = cardsCall.init?.headers as Record<string, string>;
  assertEquals(h["cookie"], "SESSION=abc123", "the session cookie must be sent or cards 401s");
});

Deno.test("a second call reuses the session instead of re-exchanging", async () => {
  const { fn, seen } = stubFetch({ "auth/exchange": { body: {} }, "/api/v1/cards": { body: [] } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  await c.cards();
  await c.cards();
  const exchanges = seen.filter((s) => s.url.includes("auth/exchange")).length;
  assertEquals(exchanges, 1, "one exchange per client, not one per call");
});

Deno.test("a failed cards call reports the HTTP status", async () => {
  const { fn } = stubFetch({ "auth/exchange": { body: {} }, "/api/v1/cards": { status: 401, body: {} } });
  const c = new FiatClient({ token: TOKEN, fetchImpl: fn });
  await assertRejects(() => c.cards(), FiatError, "HTTP 401");
});

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


// ---- RED: card-detail calls must warm the session first --------------------
//
// MEASURED 2026-10-19: on a COLD process, `requestCardDetails` returned
// 401 Unauthorized while `cards()` succeeded seconds later with the SAME token.
// Repeating details 3x after cards() gave 3x 200. So the token and the scope are
// fine -- the method simply issued its first request before the auth session
// existed. A 401 here reads as "no permission to see card values", which is a
// dangerously wrong diagnosis for an automation that is about to spend money.
//
// Rule: every authenticated endpoint must call ensureSession() before its first
// request, not rely on the caller having called cards() first.
Deno.test("requestCardDetails authenticates before its first request", async () => {
  const calls: string[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("auth/exchange")) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "set-cookie": "sid=abc; Path=/", "content-type": "application/json" },
      }));
    }
    if (url.includes("prepaid-cards/details/")) {
      // Succeed ONLY if the session cookie was already established -- exactly how
      // the real edge behaves.
      const hdrs = new Headers(init?.headers as HeadersInit);
      const ok = hdrs.get("cookie") === "sid=abc";
      return Promise.resolve(new Response(
        ok ? JSON.stringify({ cardNumber: "4111111111111111", cvv: "123", expirationDate: "12/27" })
           : JSON.stringify({ error: "Unauthorized" }),
        { status: ok ? 200 : 401, headers: { "content-type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  const c = new FiatClient({
    token: "t", fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5000,
  });
  // COLD call: no cards() first.
  const d = await c.requestCardDetails("card1");
  assertEquals(d.cardNumber, "4111111111111111");
  // the auth exchange must precede the details request
  const iAuth = calls.findIndex((u) => u.includes("auth/exchange"));
  const iDetails = calls.findIndex((u) => u.includes("prepaid-cards/details/"));
  if (iAuth < 0 || iAuth > iDetails) {
    throw new Error(`auth did not precede details: ${JSON.stringify(calls.map(u => u.split("/api/v1/")[1] ?? u))}`);
  }
});
