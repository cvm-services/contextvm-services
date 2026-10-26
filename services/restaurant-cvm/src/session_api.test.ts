/**
 * Tests for the session API. Driven through `handle()` directly — no port, no
 * browser — so the two rules that protect money are verified on every run:
 *
 *   1. knowing a session id is NOT authority (only its owner may touch it);
 *   2. one controller at a time (two phones clicking one form corrupts an order).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handle, SessionStore, type Spawner } from "./session_api.ts";

const TOK_A = "tok-facilitator-a";
const TOK_B = "tok-facilitator-b";

let store: SessionStore;
let now: number;
let spawnCalls: string[];

const spawn: Spawner = async (order_id) => {
  spawnCalls.push(order_id);
  return { novnc_url: `https://s.example/vnc.html?x=${order_id}`, expires_at: now + 60_000 };
};

const ctx = () => ({ tokens: new Map([[TOK_A, "fac-a"], [TOK_B, "fac-b"]]), now: () => now });

function req(method: string, path: string, token?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  handle(req(method, path, token, body), store, ctx());

/** Put a session into a state where a human may hold control. */
function atCaptcha(session_id: string) {
  store.get(session_id, "fac-a")!.state = "awaiting_human";
}

beforeEach(() => {
  now = 1_800_000_000_000;
  spawnCalls = [];
  store = new SessionStore(spawn, () => now);
});

describe("authentication", () => {
  test("no token is 401 and spawns nothing", async () => {
    const r = await call("POST", "/sessions", undefined, { order_id: "o1" });
    expect(r.status).toBe(401);
    expect(spawnCalls).toEqual([]);
  });

  test("a bad token is 401", async () => {
    const r = await call("POST", "/sessions", "nope", { order_id: "o1" });
    expect(r.status).toBe(401);
  });
});

describe("ownership — a session id is not authority", () => {
  test("another facilitator gets 404, not 403 (no id oracle)", async () => {
    const created = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    const r = await call("GET", `/sessions/${created.session_id}`, TOK_B);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no such session" });
  });

  test("the owner can read it and gets the capability URL back after a reload", async () => {
    const created = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    const r = await call("GET", `/sessions/${created.session_id}`, TOK_A);
    expect(r.status).toBe(200);
    expect((await r.json()).novnc_url).toContain("o1");
  });

  test("the list shows only your own sessions, and never the URL", async () => {
    await call("POST", "/sessions", TOK_A, { order_id: "a1" });
    await call("POST", "/sessions", TOK_B, { order_id: "b1" });
    const list = await (await call("GET", "/sessions", TOK_A)).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].order_id).toBe("a1");
    expect(list.sessions[0].novnc_url).toBeUndefined();
  });
});

describe("one active session per order", () => {
  test("a second create for the same order is refused and does not spawn", async () => {
    await call("POST", "/sessions", TOK_A, { order_id: "dup" });
    const r = await call("POST", "/sessions", TOK_A, { order_id: "dup" });
    expect(r.status).toBe(409);
    expect(spawnCalls).toEqual(["dup"]);
  });
});

describe("controller lease — two phones, one browser", () => {
  test("a second controller is refused with 409 and told it is held", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    atCaptcha(s.session_id);
    const first = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-1",
    });
    // Assert the FIRST acquisition succeeded, or this test passes on a lease
    // implementation that refuses everything.
    expect(first.status).toBe(200);

    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-2",
    });
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toBeTruthy();
  });

  test("takeover is explicit, allowed, and audited", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    atCaptcha(s.session_id);
    expect((await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-1",
    })).status).toBe(200);
    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-2",
      takeover: true,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.controller).toBeTruthy();
    // The takeover must leave a trace: a silent transfer of control over a
    // payment form is not acceptable.
    const s2 = store.get(s.session_id, "fac-a")!;
    expect(s2.control_log.map((c) => c.takeover)).toEqual([false, true]);
  });

  test("the same controller re-acquiring is idempotent, not a conflict", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    atCaptcha(s.session_id);
    expect((await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "p1",
    })).status).toBe(200);
    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, { controller: "p1" });
    expect(r.status).toBe(200);
  });

  test("a non-controllable state refuses control", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    // 'preparing' is not a human-control state.
    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "p1",
    });
    expect(r.status).toBe(409);
  });
});

describe("expiry is evaluated on read, never trusted from a stored flag", () => {
  test("a session expires by the clock and drops its controller", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    store.get(s.session_id, "fac-a")!.state = "awaiting_human";
    await call("POST", `/sessions/${s.session_id}/control`, TOK_A, { controller: "p1" });

    now += 61_000; // past expires_at

    const r = await (await call("GET", `/sessions/${s.session_id}`, TOK_A)).json();
    expect(r.state).toBe("expired");
    expect(r.controller).toBeNull();
  });

  test("an expired session cannot be controlled", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    store.get(s.session_id, "fac-a")!.state = "awaiting_human";
    now += 61_000;
    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "p1",
    });
    expect(r.status).toBe(409);
  });

  test("a terminal state is never rewritten to expired", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    store.get(s.session_id, "fac-a")!.state = "outcome_unknown";
    now += 61_000;
    const r = await (await call("GET", `/sessions/${s.session_id}`, TOK_A)).json();
    // outcome_unknown must reach the UI as unknown; rewriting it to 'expired'
    // would invite a retry of a purchase that may already have happened.
    expect(r.state).toBe("outcome_unknown");
  });
});

describe("teardown", () => {
  test("delete removes the session and it stops resolving", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    expect((await call("DELETE", `/sessions/${s.session_id}`, TOK_A)).status).toBe(204);
    expect((await call("GET", `/sessions/${s.session_id}`, TOK_A)).status).toBe(404);
  });

  test("a non-owner cannot tear down someone else's session", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o1" })).json();
    expect((await call("DELETE", `/sessions/${s.session_id}`, TOK_B)).status).toBe(404);
  });
});

// --- grants: the edge check that turns the lease into access control --------
// Without these, the lease is bookkeeping: Caddy cannot read our memory, so any
// request reaching the proxy is served and whoever learns a session URL drives a
// browser containing a payment form.
describe("edge authorization", () => {
  const edge = (session: string, grant?: string, cookie?: string) => {
    const headers: Record<string, string> = {};
    if (grant) headers["x-cvm-grant"] = grant;
    if (cookie) headers["cookie"] = cookie;
    return handle(
      new Request(`https://api.example/edge/authorize?session=${session}`, { headers }),
      store,
      ctx(),
    );
  };

  async function ownedSession(order = "o1") {
    // Distinct orders: a second session for the SAME order is correctly refused,
    // which would make this helper return nothing and mask the real assertion.
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: order })).json();
    atCaptcha(s.session_id);
    const c = await (await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-1",
    })).json();
    return { id: s.session_id as string, grant: c.grant as string };
  }

  test("control issues a grant and the edge accepts it", async () => {
    const { id, grant } = await ownedSession();
    expect(grant).toMatch(/^[0-9a-f]{32,}$/);
    expect((await edge(id, grant)).status).toBe(200);
  });

  test("no grant is denied", async () => {
    const { id } = await ownedSession();
    expect((await edge(id)).status).toBe(401);
  });

  test("a grant is bound to ONE session and cannot be replayed elsewhere", async () => {
    const a = await ownedSession("order-a");
    const b = await ownedSession("order-b");
    expect((await edge(b.id, a.grant)).status).toBe(401);
  });

  test("the grant works from a cookie (the viewer's real transport)", async () => {
    const { id, grant } = await ownedSession();
    expect((await edge(id, undefined, `other=1; cvm_grant=${grant}`)).status).toBe(200);
  });

  test("an expired grant is denied and dropped", async () => {
    const { id, grant } = await ownedSession();
    now += 121_000; // past the 120s default TTL
    expect((await edge(id, grant)).status).toBe(401);
  });

  test("a grant dies with teardown", async () => {
    const { id, grant } = await ownedSession();
    await call("DELETE", `/sessions/${id}`, TOK_A);
    expect((await edge(id, grant)).status).toBe(401);
  });

  test("a grant dies with release, so logout is real", async () => {
    const { id, grant } = await ownedSession();
    await call("DELETE", `/sessions/${id}/control`, TOK_A, { controller: "phone-1" });
    expect((await edge(id, grant)).status).toBe(401);
  });

  test("takeover revokes the previous controller's grant immediately", async () => {
    const { id, grant } = await ownedSession();
    await call("POST", `/sessions/${id}/control`, TOK_A, {
      controller: "phone-2",
      takeover: true,
    });
    // The displaced device must lose access at once, not at TTL.
    expect((await edge(id, grant)).status).toBe(401);
  });

  test("a grant dies when the session expires", async () => {
    const { id, grant } = await ownedSession();
    now += 61_000; // session expires_at
    expect((await edge(id, grant)).status).toBe(401);
  });

  test("only the current controller may mint a grant", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "o9" })).json();
    atCaptcha(s.session_id);
    await call("POST", `/sessions/${s.session_id}/control`, TOK_A, { controller: "phone-1" });
    const r = await call("POST", `/sessions/${s.session_id}/control`, TOK_A, {
      controller: "phone-2",
    });
    expect(r.status).toBe(409); // phone-2 neither holds the lease nor can mint one
  });
});
