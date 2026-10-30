/** Option A customer API: pricing, LNURLP invoice, status, no treasury spend. */
import { createHandler, priceBasket, type MenuItem } from "./serve_customer_lnurlp.ts";

const MENU: MenuItem[] = [
  { id: "m1", name: "Margherita", sats: 1000, eur: 4 },
  { id: "m2", name: "Birra", sats: 500, eur: 2 },
];

function eq(a: unknown, b: unknown, msg = "") {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: ${ja} !== ${jb}`);
}

function fakeFetch(state: { status: string; venue_ref?: string | null; fail?: boolean }) {
  const calls: Array<{ url: string; body?: any; auth?: string }> = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers as HeadersInit).get("authorization") ?? undefined;
    calls.push({ url, body, auth });
    if (state.fail) {
      return Promise.resolve(new Response(JSON.stringify({ error: "No funds" }), {
        status: 502, headers: { "content-type": "application/json" },
      }));
    }
    if (url.endsWith("/lnurlp/internal/orders") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({
        order_id: body.order_id, sats: body.sats, bolt11: "lnbc2750n1test",
        payment_hash: "hash", status: "pending",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.endsWith("/claim") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({
        order_id: "o1", sats: 2750, status: "paid", claimed: true,
        venue_ref: null, paid_at: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.includes("/lnurlp/internal/orders/")) {
      return Promise.resolve(new Response(JSON.stringify({
        order_id: "o1", sats: 2750, status: state.status,
        venue_ref: state.venue_ref ?? null, paid_at: state.status === "paid" ? 1 : null,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function handlerFor(state: { status: string; venue_ref?: string | null; fail?: boolean }) {
  const fake = fakeFetch(state);
  const handler = createHandler({
    menu: MENU, lnurlpBase: "http://lnurlp.test", lnurlpToken: "internal-token",
    marginPct: 10, fetchImpl: fake.fn,
  });
  return { handler, fake };
}

const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(new Request(`http://x${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const get = (handler: (r: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://x${path}`));

Deno.test("menu is served from the fixture and the server prices the basket", async () => {
  const { handler, fake } = handlerFor({ status: "pending" });
  const menu = await (await get(handler, "/menu")).json();
  eq(menu.items.length, 2);
  const res = await post(handler, "/orders", { items: [{ id: "m1", qty: 2 }, { id: "m2", qty: 1 }] });
  const body = await res.json();
  eq(res.status, 201);
  eq(body.sats, 2750); // 2500 + 10%
  eq(body.estimate_sats, 2500);
  eq(body.price_source, "facilitator_lnurl");
  eq(body.bolt11, "lnbc2750n1test");
  eq(fake.calls[0].body.sats, 2750);
  eq(fake.calls[0].auth, "Bearer internal-token");
});

Deno.test("client prices are ignored and bad baskets are refused", async () => {
  const { handler } = handlerFor({ status: "pending" });
  const ok = await (await post(handler, "/orders", {
    items: [{ id: "m1", qty: 1, sats: 1, price: 1 }],
  })).json();
  eq(ok.sats, 1100);
  for (const body of [
    { items: [] },
    { items: [{ id: "nope", qty: 1 }] },
    { items: [{ id: "m1", qty: 0 }] },
    { items: [{ id: "m1", qty: 999 }] },
  ]) {
    const res = await post(handler, "/orders", body);
    if (res.status !== 400) throw new Error("expected 400");
  }
});

Deno.test("order status maps to invoiced/paid and carries the venue reference", async () => {
  const pending = handlerFor({ status: "pending" });
  let r = await (await get(pending.handler, "/orders/o1")).json();
  eq(r.state, "invoiced");
  eq(r.must_not_repay, false);

  const paid = handlerFor({ status: "paid", venue_ref: null });
  r = await (await get(paid.handler, "/orders/o1")).json();
  eq(r.state, "paid");
  eq(r.venue_ref, null);

  const confirmed = handlerFor({ status: "paid", venue_ref: "TB-42" });
  r = await (await get(confirmed.handler, "/orders/o1")).json();
  eq(r.state, "paid");
  eq(r.venue_ref, "TB-42");
});

Deno.test("the customer service never pays: /pay is a 409", async () => {
  const { handler } = handlerFor({ status: "pending" });
  const res = await post(handler, "/orders/o1/pay", { key: "k" });
  eq(res.status, 409);
  eq((await res.json()).error, "customer_pays_invoice");
});

Deno.test("a LNURLP invoice failure returns the detail", async () => {
  const { handler } = handlerFor({ status: "pending", fail: true });
  const res = await post(handler, "/orders", { items: [{ id: "m1", qty: 1 }] });
  eq(res.status, 502);
  const body = await res.json();
  eq(body.error, "invoice_failed");
  if (!String(body.detail).includes("No funds")) throw new Error("detail lost");
});

Deno.test("priceBasket refuses fractional/negative quantities", () => {
  for (const qty of [0, -1, 1.5]) {
    let threw = false;
    try { priceBasket(MENU, [{ id: "m1", qty }], 10); } catch { threw = true; }
    if (!threw) throw new Error(`qty ${qty} accepted`);
  }
});

Deno.test("the customer check route forces a claim and returns paid", async () => {
  const { handler, fake } = handlerFor({ status: "paid" });
  const res = await post(handler, "/orders/o1/check", {});
  eq(res.status, 200);
  const body = await res.json();
  eq(body.state, "paid");
  eq(body.claimed, true);
  const last = fake.calls[fake.calls.length - 1];
  if (!String(last.url).endsWith("/lnurlp/internal/orders/o1/claim")) {
    throw new Error("check did not call the forced claim: " + last.url);
  }
});
