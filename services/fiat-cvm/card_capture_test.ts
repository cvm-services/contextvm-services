// Card-value handling: the guarantees that make ADR-0013's amendment safe.
//
// Every card number here is SYNTHETIC (a well-known test PAN). No real card value
// is used, fetched, or required by this file — that is deliberate: the risky part
// is the handling discipline, and it can be proven without touching a real card.
//
// The properties asserted:
//   1. a handle redacts when printed or JSON-encoded;
//   2. a handle is single-use — CVV cannot be reused for a second charge;
//   3. values are destroyed even when the charge THROWS;
//   4. no error message contains a card value;
//   5. a provider response missing values fails loudly rather than charging blind;
//   6. an OTP is read from the provider's `otp` object, and absence returns null.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FiatClient, FiatError } from "./fiat_client.ts";
import { cardValues, pendingOtp, CardHandle } from "./card_capture.ts";

// Standard test PAN (4111… is the conventional test number). Synthetic.
const TEST_PAN = "4111111111111111";
const TEST_CVV = "123";

function clientReturning(details: unknown, otp: unknown = {}) {
  return new FiatClient({
    token: "t".repeat(38),
    baseUrl: "https://2fiat.test",
    fetchImpl: ((u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("auth/exchange")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      if (url.includes("/otp")) {
        return Promise.resolve(new Response(JSON.stringify(otp), { status: 200 }));
      }
      if (url.includes("/details/")) {
        return Promise.resolve(new Response(JSON.stringify(details), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
}

Deno.test("a handle NEVER reveals the PAN via toString or JSON", async () => {
  const c = clientReturning({
    cardNumber: TEST_PAN, cvv: TEST_CVV, expirationDate: "08/27",
  });
  const h = await cardValues(c, "card-1", "5257 **** **** 9166");

  // The two ways values escape by accident in practice:
  const printed = `${h}`;
  const json = JSON.stringify({ card: h });

  assertEquals(printed.includes(TEST_PAN), false, `toString leaked the PAN: ${printed}`);
  assertEquals(json.includes(TEST_PAN), false, `toJSON leaked the PAN: ${json}`);
  assertEquals(printed.includes(TEST_CVV), false, `toString leaked the CVV: ${printed}`);
  assertEquals(json.includes(TEST_CVV), false, `toJSON leaked the CVV: ${json}`);
  assertEquals(printed.includes("5257 **** **** 9166"), true, "the masked number is safe to show");
});

Deno.test("values are destroyed after ONE use — CVV cannot be reused", async () => {
  const c = clientReturning({
    cardNumber: TEST_PAN, cvv: TEST_CVV, expirationDate: "08/27",
  });
  const h = await cardValues(c, "card-1", "**** 9166");

  const seen = await h.use(async (v) => ({ pan: v.cardNumber, cvv: v.cvv }));
  assertEquals(seen.pan, TEST_PAN);
  assertEquals(seen.cvv, TEST_CVV);
  assertEquals(h.alive, false, "handle must be dead after use");

  // A second charge must refuse rather than silently reusing a consumed CVV.
  await assertRejects(() => h.use(async (v) => v.cardNumber), FiatError);
});

Deno.test("values are destroyed even when the charge THROWS", async () => {
  const c = clientReturning({
    cardNumber: TEST_PAN, cvv: TEST_CVV, expirationDate: "08/27",
  });
  const h = await cardValues(c, "card-1", "**** 9166");

  await assertRejects(
    () => h.use(async () => { throw new Error("merchant declined"); }),
    Error,
  );
  assertEquals(h.alive, false, "a failed charge must still destroy the values");
});

Deno.test("an incomplete provider response fails loudly, never charges blind", async () => {
  const c = clientReturning({ cardNumber: "", cvv: "", expirationDate: "" });
  const err = await assertRejects(() => cardValues(c, "card-1", "**** 9166"), FiatError);
  // The error names WHICH field was missing, without printing any value.
  const msg = String(err.message);
  assertEquals(msg.includes("MISSING"), true);
  assertEquals(msg.includes(TEST_PAN), false);
});

Deno.test("a thrown FiatError carries no card value", async () => {
  const c = clientReturning({});
  const err = await assertRejects(() => cardValues(c, "card-1", "5257 **** **** 9166"), FiatError);
  const msg = String(err.message);
  assertEquals(msg.includes(TEST_PAN), false, `error leaked a PAN: ${msg}`);
  assertEquals(msg.includes(TEST_CVV), false, `error leaked a CVV: ${msg}`);
});

Deno.test("pendingOtp reads the provider's otp object, and returns null when absent", async () => {
  const withOtp = clientReturning({}, {
    otp: { code: "654321", merchantName: "THREE BUDDIES", amount: "10.65", currency: "USD" },
  });
  const got = await pendingOtp(withOtp, "card-1");
  assertEquals(got?.code, "654321");
  assertEquals(got?.merchantName, "THREE BUDDIES");
  assertEquals(got?.amount, "10.65");

  const noOtp = clientReturning({}, {});
  assertEquals(await pendingOtp(noOtp, "card-1"), null);
});

Deno.test("CardHandle expose aliveness and the masked number only", () => {
  const h = new CardHandle("c1", "**** 1234", {
    cardNumber: TEST_PAN, cvv: TEST_CVV, expirationDate: "08/27",
  });
  assertEquals(h.alive, true);
  assertEquals(h.masked, "**** 1234");
  assertEquals(h.cardId, "c1");
});
