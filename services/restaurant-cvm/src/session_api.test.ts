/**
 * Tests for the session API. Driven through `handle()` directly — no port, no
 * browser — so the two rules that protect money are verified on every run:
 *
 *   1. knowing a session id is NOT authority (only its owner may touch it);
 *   2. one controller at a time (two phones clicking one form corrupts an order).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handle, setStateReader, SessionStore, type Spawner } from "./session_api.ts";
import { FacilitatorAuth } from "./facilitator_auth.ts";

const TOK_A = "tok-facilitator-a";
const TOK_B = "tok-facilitator-b";

let store: SessionStore;
let now: number;
let spawnCalls: string[];

const spawn: Spawner = async (order_id) => {
  spawnCalls.push(order_id);
  return { novnc_url: `https://s.example/vnc.html?x=${order_id}`, expires_at: now + 60_000,
      state_file: "/tmp/fake-state.json" };
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

// --- state sync: the API must not lie about the one thing it exists to show --
describe("harness state sync", () => {
  test("the API reflects the harness instead of staying 'preparing'", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "sync1" })).json();
    expect(s.state).toBe("preparing");
    // The harness owns the truth; the API only translates it.
    setStateReader(() => JSON.stringify({ state: "awaiting_human" }));
    const got = await (await call("GET", `/sessions/${s.session_id}`, TOK_A)).json();
    expect(got.state).toBe("awaiting_human");
    expect(got.controllable).toBe(true);
  });

  test("a terminal state is never resurrected by a late harness write", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "sync2" })).json();
    await call("DELETE", `/sessions/${s.session_id}`, TOK_A); // expired
    setStateReader(() => JSON.stringify({ state: "awaiting_human" }));
    const r = await call("GET", `/sessions/${s.session_id}`, TOK_A);
    expect(r.status).toBe(404); // torn down stays torn down
  });

  test("a missing or half-written state file is not an error", async () => {
    const s = await (await call("POST", "/sessions", TOK_A, { order_id: "sync3" })).json();
    setStateReader(() => null);
    expect((await call("GET", `/sessions/${s.session_id}`, TOK_A)).status).toBe(200);
    setStateReader(() => '{"state":');
    expect((await call("GET", `/sessions/${s.session_id}`, TOK_A)).status).toBe(200);
  });
});

// --- persistence: a restart must not orphan a live browser session ----------
describe("session persistence", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { m, read: (p: string) => m.get(p) ?? null, write: (p: string, t: string) => { m.set(p, t); } };
  };
  const stubSpawn: Spawner = async (order_id, _f, session_id) => ({
    novnc_url: `https://s.example/vnc.html?${session_id}`,
    expires_at: 9_999_999_999_999,
    state: "awaiting_human",
    state_file: `/tmp/fake-${order_id}.json`,
  });
  const ctxNoAuth = { tokens: new Map([[TOK_A, "fac-a"]]), now: () => 1000 };

  test("a session survives a restart", async () => {
    const file = mem();
    const a = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    await a.create("o1", "fac-a");
    const id = [...a.list("fac-a")][0].id;

    // process restarts: brand-new store, same file
    const b = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    expect(b.get(id, "fac-a").id).toBe(id);
  });

  test("a restart does NOT restore grants: access must be re-taken", async () => {
    const file = mem();
    // A grant requires a controllable session AND the lease: you cannot mint
    // access you do not hold.
    setStateReader((p) => (p.includes("/tmp/fake-") ? JSON.stringify({ state: "awaiting_human" }) : null));
    const a = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    await a.create("o1", "fac-a");
    const id = [...a.list("fac-a")][0].id;
    a.control(id, "fac-a", "phone-1");
    const grant = a.issueGrant(id, "fac-a", "phone-1");
    expect(a.authorize(grant.token, id)).not.toBeNull();

    const b = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    // Same token, same session id: refused after restart. Failing closed is the
    // right direction for something that drives a payment form.
    expect(b.authorize(grant.token, id)).toBeNull();
  });

  test("a corrupt table starts empty instead of crashing the service", () => {
    const file = mem();
    file.m.set("/x/sessions.json", "{not json");
    const s = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    expect([...s.list("fac-a")].length).toBe(0);
  });

  test("ids are not reused after a restart", async () => {
    const file = mem();
    const a = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    await a.create("o1", "fac-a");
    const first = [...a.list("fac-a")][0].id;

    const b = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    const s2 = await b.create("o2", "fac-a");
    expect(s2.id).not.toBe(first);
  });

  test("a failing disk write does not break session creation", async () => {
    const file = { read: () => null, write: () => { throw new Error("disk full"); } };
    const s = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    expect((await s.create("o1", "fac-a")).order_id).toBe("o1");
  });

  test("teardown is persisted (a removed session stays removed)", async () => {
    const file = mem();
    const a = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    await a.create("o1", "fac-a");
    const id = [...a.list("fac-a")][0].id;
    a.remove(id, "fac-a");

    const b = new SessionStore(stubSpawn, () => 1000, { path: "/x/sessions.json", file });
    expect([...b.list("fac-a")].length).toBe(0);
  });
});

// --- sign-in: an npub replaces the pasted static token -----------------------
describe("facilitator sign-in", () => {
  const ALICE = "a".repeat(64);
  const URL = "https://api.example/auth/verify";

  function makeAuth() {
    return new FacilitatorAuth({
      allowlist: new Set([ALICE]),
      verify: (e) => e.pubkey === ALICE,
      hash: (e) => `h:${e.pubkey}:${e.content}:${JSON.stringify(e.tags)}`,
      now: () => 1_700_000_000_000,
      expected_url: URL,
    });
  }

  const signed = (nonce: string) => {
    const e: Record<string, unknown> = {
      pubkey: ALICE, kind: 27235, created_at: 1_700_000_000, content: "",
      tags: [["u", URL], ["method", "POST"], ["challenge", nonce]], sig: "sig",
    };
    e.id = `h:${ALICE}::${JSON.stringify(e.tags)}`;
    return e;
  };

  test("challenge -> verify -> the token opens the session list", async () => {
    const auth = makeAuth();
    const ctxAuth = { ...ctx(), auth };

    const ch = await handle(new Request("https://api.example/auth/challenge"), store, ctxAuth);
    expect(ch.status).toBe(200);
    const { nonce } = await ch.json();
    expect(typeof nonce).toBe("string");

    const vr = await handle(
      new Request("https://api.example/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(signed(nonce)),
      }),
      store, ctxAuth,
    );
    expect(vr.status).toBe(200);
    const { token } = await vr.json();

    const list = await handle(
      new Request("https://api.example/sessions", { headers: { authorization: `Bearer ${token}` } }),
      store, ctxAuth,
    );
    expect(list.status).toBe(200);
  });

  test("a bad signature is a 401 with no detail", async () => {
    const auth = makeAuth();
    const ctxAuth = { ...ctx(), auth };
    const ch = await handle(new Request("https://api.example/auth/challenge"), store, ctxAuth);
    const { nonce } = await ch.json();

    const bad = { ...signed(nonce), pubkey: "b".repeat(64) };
    const r = await handle(
      new Request("https://api.example/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad),
      }),
      store, ctxAuth,
    );
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe("not_authenticated"); // no reason leaked
  });

  test("sign-in endpoints are absent when auth is not configured", async () => {
    const r = await handle(new Request("https://api.example/auth/challenge"), store, ctx());
    expect(r.status).toBe(404);
  });

  test("the old static token still works during migration", async () => {
    const ctxAuth = { ...ctx(), auth: makeAuth() };
    const r = await handle(
      new Request("https://api.example/sessions", { headers: { authorization: `Bearer ${TOK_A}` } }),
      store, ctxAuth,
    );
    expect(r.status).toBe(200);
  });
});

// --- operator approval: a human decides which devices may act ---------------
describe("device approval", () => {
  const ALICE = "a".repeat(64);
  const URL = "https://api.example/auth/verify";
  const ADMIN = "admin-token-xyz";

  const authFor = (storePath?: string) => {
    const mem = new Map<string, string>();
    return new FacilitatorAuth({
      allowlist: new Set<string>(),
      verify: (e) => e.pubkey === ALICE,
      hash: (e) => `h:${e.pubkey}:${e.content}:${JSON.stringify(e.tags)}`,
      now: () => 1_700_000_000_000,
      expected_url: URL,
      store_path: storePath,
      store_file: { read: (p) => mem.get(p) ?? null, write: (p, t) => { mem.set(p, t); } },
    });
  };

  const signed = (nonce: string, pubkey = ALICE) => {
    const e: Record<string, unknown> = {
      pubkey, kind: 27235, created_at: 1_700_000_000, content: "",
      tags: [["u", URL], ["method", "POST"], ["challenge", nonce]], sig: "sig",
    };
    e.id = `h:${pubkey}::${JSON.stringify(e.tags)}`;
    return e;
  };

  async function trySignIn(a: FacilitatorAuth, pubkey = ALICE) {
    const ctxA = { ...ctx(), auth: a, admin_token: ADMIN };
    const ch = await (await handle(new Request("https://api.example/auth/challenge"), store, ctxA)).json();
    return await handle(
      new Request("https://api.example/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(signed(ch.nonce, pubkey)),
      }),
      store, ctxA,
    );
  }
  const admin = (path: string, method = "GET", token = ADMIN) =>
    handle(new Request(`https://api.example${path}`, {
      method, headers: { authorization: `Bearer ${token}` },
    }), store, { ...ctx(), auth: a0, admin_token: ADMIN });

  let a0: FacilitatorAuth;
  beforeEach(() => { a0 = authFor(); });

  test("a refused device appears in the pending list, not in a void", async () => {
    const r = await trySignIn(a0);
    expect(r.status).toBe(401);
    const pending = a0.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].npub).toBe(ALICE);
    expect(pending[0].attempts).toBe(1);
  });

  test("repeat attempts increment rather than duplicate", async () => {
    await trySignIn(a0);
    await trySignIn(a0);
    expect(a0.listPending().length).toBe(1);
    expect(a0.listPending()[0].attempts).toBe(2);
  });

  test("the operator approves, and the same device can now sign in", async () => {
    await trySignIn(a0);
    const ok = await admin(`/admin/devices/${ALICE}/approve`, "POST");
    expect(ok.status).toBe(200);
    expect((await trySignIn(a0)).status).toBe(200);
    expect(a0.listPending().length).toBe(0);
  });

  test("admin endpoints reject a wrong token and refuse to exist without one", async () => {
    expect((await admin("/admin/devices", "GET", "wrong")).status).toBe(401);
    const noAdmin = await handle(
      new Request("https://api.example/admin/devices", { headers: { authorization: "Bearer x" } }),
      store, { ...ctx(), auth: a0 },
    );
    expect(noAdmin.status).toBe(404); // absent, not merely forbidden
  });

  test("removing an approved device revokes its live tokens", async () => {
    a0.approve(ALICE);
    const r = await trySignIn(a0);
    expect(r.status).toBe(200);
    const { token } = await r.json();

    expect(a0.remove(ALICE)).toBe(true);
    expect(a0.verifyToken(token)).toBeNull();
  });

  test("approvals survive a restart; a forgotten allowlist is a silent outage", async () => {
    const mem = new Map<string, string>();
    const mk = () => new FacilitatorAuth({
      allowlist: new Set<string>(),
      verify: (e) => e.pubkey === ALICE,
      hash: (e) => `h:${e.pubkey}:${e.content}:${JSON.stringify(e.tags)}`,
      now: () => 1_700_000_000_000,
      expected_url: URL,
      store_path: "/x/auth.json",
      store_file: { read: (p) => mem.get(p) ?? null, write: (p, t) => { mem.set(p, t); } },
    });
    const first = mk();
    first.approve(ALICE);

    const second = mk(); // restart
    expect(second.listApproved()).toContain(ALICE);
  });

  test("a malformed npub is refused by the admin route", async () => {
    expect((await admin("/admin/devices/not-a-key/approve", "POST")).status).toBe(400);
  });
});
