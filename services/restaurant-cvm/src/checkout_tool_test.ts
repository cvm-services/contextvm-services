/**
 * The checkout tool spends money, so its authorization rules are the test.
 * Nothing here starts a browser: the session API is a stub fetch.
 */
import { startCheckout } from "../server.ts";

const ALLOWED = "c3e23eb5e3d00f18b2f4f588d8cdbc548648be761bdd90812186df4603d7caa9";
const OTHER = "11".repeat(32);

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

function fakeFetch(captured: Array<{ url: string; init?: RequestInit }>, status = 201) {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    const body = status === 201
      ? { session_id: "s_1", state: "preparing",
          novnc_url: "https://example.test/venue/view/t/vnc.html",
          expires_at: "2026-10-29T22:00:00Z" }
      : { error: "order already has an active session" };
    return Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

Deno.test("checkout is refused when the venue is not configured", async () => {
  setEnv({ CVM_SESSION_API: undefined, CVM_SESSION_TOKEN: undefined });
  const r = await startCheckout({ order_id: "o1" }, { pubkey: ALLOWED });
  if (!r.isError || !text(r).includes("not configured")) throw new Error(text(r));
});

Deno.test("checkout refuses an unsigned request", async () => {
  setEnv({ CVM_SESSION_API: "http://session.test", CVM_SESSION_TOKEN: "t",
           CVM_FACILITATOR_NPUBS: ALLOWED });
  const r = await startCheckout({ order_id: "o1" });
  if (!r.isError || !text(r).includes("signed request")) throw new Error(text(r));
});

Deno.test("checkout refuses a key outside the allowlist", async () => {
  setEnv({ CVM_SESSION_API: "http://session.test", CVM_SESSION_TOKEN: "t",
           CVM_FACILITATOR_NPUBS: ALLOWED });
  const r = await startCheckout({ order_id: "o1" }, { pubkey: OTHER });
  if (!r.isError || !text(r).includes("not an allowed facilitator")) {
    throw new Error(text(r));
  }
});

Deno.test("checkout requires an order id", async () => {
  setEnv({ CVM_SESSION_API: "http://session.test", CVM_SESSION_TOKEN: "t",
           CVM_FACILITATOR_NPUBS: ALLOWED });
  const r = await startCheckout({}, { pubkey: ALLOWED });
  if (!r.isError || !text(r).includes("order_id")) throw new Error(text(r));
});

Deno.test("an allowlisted key starts a session with the service bearer", async () => {
  setEnv({ CVM_SESSION_API: "http://session.test", CVM_SESSION_TOKEN: "service-token",
           CVM_FACILITATOR_NPUBS: `${OTHER}, ${ALLOWED}` });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const r = await startCheckout({ order_id: "o_42" }, { pubkey: ALLOWED },
                                fakeFetch(calls));
  if (r.isError) throw new Error(text(r));
  if (!text(r).includes("s_1") || !text(r).includes("novnc")) throw new Error(text(r));
  if (calls.length !== 1 || calls[0].url !== "http://session.test/sessions") {
    throw new Error(JSON.stringify(calls.map((c) => c.url)));
  }
  const headers = new Headers(calls[0].init?.headers as HeadersInit);
  if (headers.get("authorization") !== "Bearer service-token") {
    throw new Error("wrong bearer");
  }
  if (JSON.parse(String(calls[0].init?.body))["order_id"] !== "o_42") {
    throw new Error("wrong body");
  }
});

Deno.test("a session API refusal is reported, not swallowed", async () => {
  setEnv({ CVM_SESSION_API: "http://session.test", CVM_SESSION_TOKEN: "t",
           CVM_FACILITATOR_NPUBS: ALLOWED });
  const r = await startCheckout({ order_id: "o_42" }, { pubkey: ALLOWED },
                                fakeFetch([], 409));
  if (!r.isError || !text(r).includes("HTTP 409")) throw new Error(text(r));
});
