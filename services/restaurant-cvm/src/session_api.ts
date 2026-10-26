/**
 * Facilitator captcha-session API (ADR-0017, P0 #1/#1b/#3).
 *
 * WHY THIS EXISTS
 *   The harness writes a state file on the operator host. A dashboard running
 *   anywhere else cannot read that, and a session bound to nothing lets anyone
 *   who learns the URL drive a live browser containing a payment form. So:
 *   this is the only door to a session, and it answers three questions the
 *   decision record says must be answerable before real money flows:
 *
 *     1. WHOSE session is this?      -> facilitator binding (403 otherwise)
 *     2. MAY I DRIVE IT RIGHT NOW?   -> single-controller lease (409 otherwise)
 *     3. IS IT STILL ALIVE?          -> state, expiry, teardown
 *
 * DESIGN NOTES THAT MATTER
 *   - Authorization is checked on the SESSION, not on the route: a facilitator
 *     may read only their own sessions. Knowing a session id is not authority.
 *   - The controller lease is server-enforced and single-holder. Two phones
 *     injecting clicks into one browser is a real corruption mode, so a second
 *     controller gets 409 with the current holder, and takeover is explicit and
 *     audited rather than silent.
 *   - Expiry is evaluated on read, never trusted from a stored flag: a process
 *     that dies mid-session must not leave a permanently live grant behind.
 *   - `outcome_unknown` propagates untouched. It is NOT an error state: after a
 *     payment submission an unknown outcome must reach the UI as unknown, or
 *     someone retries and buys the meal twice.
 */

export type SessionState =
  | "preparing"
  | "at_captcha"
  | "awaiting_human"
  | "solved"
  | "continuing"
  | "awaiting_sms"
  | "submitting"
  | "completed"
  | "failed"
  | "expired"
  | "outcome_unknown";

/** The canonical business states. Mirrors the harness; one list, one truth. */
export const STATES: readonly SessionState[] = [
  "preparing", "at_captcha", "awaiting_human", "solved", "continuing",
  "awaiting_sms", "submitting", "completed",
  "failed", "expired", "outcome_unknown",
];

/** Injectable so tests never touch the filesystem. */
let readStateFile: (p: string) => string | null = (p) => {
  try { return Deno.readTextFileSync(p); } catch { return null; }
};
export function setStateReader(fn: (p: string) => string | null): void {
  readStateFile = fn;
}

/** States in which a human may hold control of the browser. */
const CONTROLLABLE: ReadonlySet<SessionState> = new Set<SessionState>([
  "at_captcha",
  "awaiting_human",
]);

export interface Session {
  id: string;
  order_id: string;
  facilitator: string;
  state: SessionState;
  created_at: number;
  expires_at: number;
  novnc_url?: string;
  /** Harness state file, read on every access so the API cannot go stale. */
  state_file?: string;
  /** Current controller, if any. Single-holder. */
  controller: { id: string; since: number } | null;
  /** Audit trail: every control acquisition, including takeovers. */
  control_log: { controller: string; at: number; takeover: boolean }[];
  reason?: string;
}

/**
 * A short-lived grant is what turns the controller lease into ACCESS CONTROL.
 *
 * The lease alone only coordinates: it says who *should* be driving. The edge
 * (Caddy) cannot read our in-memory lease, so without a grant any request that
 * reaches the proxy is served — i.e. whoever learns a session URL drives a
 * browser containing a payment form. A grant is the lease, expressed as
 * something the edge can verify on every request including the WebSocket
 * upgrade.
 *
 * Deliberately NOT single-use: a noVNC connection reconnects after a network
 * blip, and burning the grant on first connect would drop the operator mid-
 * captcha. It is TTL-bound and revoked explicitly instead.
 */
export interface Grant {
  token: string;
  session_id: string;
  controller: string;
  expires_at: number;
}

export interface ApiContext {
  /** Token -> facilitator id. Supplied by config; never literal in code. */
  tokens: Map<string, string>;
  now?: () => number;
  /** How long an edge grant lives. Short by design: it is re-issued on demand. */
  grant_ttl_ms?: number;
}

export type SpawnResult = {
  novnc_url: string;
  expires_at: number;
  state?: SessionState;
  /** Where the harness publishes its authoritative state. */
  state_file?: string;
};

/** Injected so tests never touch a real browser, and production can swap it. */
export type Spawner = (
  order_id: string,
  facilitator: string,
  session_id: string,
) => Promise<SpawnResult>;

/**
 * Where sessions are kept between process lifetimes. Injected so tests need no
 * filesystem and no runtime-specific API.
 */
export interface StoreFile {
  read(path: string): string | null;
  write(path: string, text: string): void;
}

const defaultStoreFile: StoreFile = {
  read(path) {
    try {
      // deno-lint-ignore no-explicit-any
      const d = (globalThis as any).Deno;
      return d ? d.readTextFileSync(path) : null;
    } catch {
      return null;
    }
  },
  write(path, text) {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    if (!d) return;
    // Atomic: a crash mid-write must not leave a truncated session table.
    const tmp = `${path}.tmp`;
    d.writeTextFileSync(tmp, text);
    d.renameSync(tmp, path);
  },
};

export class SessionStore {
  #sessions = new Map<string, Session>();
  #grants = new Map<string, Grant>();
  #spawn: Spawner;
  #now: () => number;
  #seq = 0;
  #path?: string;
  #file: StoreFile;

  constructor(
    spawn: Spawner,
    now: () => number = () => Date.now(),
    opts: { path?: string; file?: StoreFile } = {},
  ) {
    this.#spawn = spawn;
    this.#now = now;
    this.#path = opts.path;
    this.#file = opts.file ?? defaultStoreFile;
    if (this.#path) this.#load();
  }

  /**
   * Restore sessions after a restart.
   *
   * WHY: the in-memory store forgot every session while the harness kept running
   * - observed live, when restarting the API orphaned a browser session that was
   * still holding a venue checkout. A dashboard that has lost the session cannot
   * hand it to anyone.
   *
   * Grants are deliberately NOT restored: a restart should invalidate access, so
   * the operator re-takes control and gets a fresh grant. Failing closed on
   * restart is the safer direction for something that drives a payment form.
   */
  #load(): void {
    const raw = this.#file.read(this.#path!);
    if (!raw) return;
    try {
      const rows = JSON.parse(raw) as Session[];
      if (!Array.isArray(rows)) return;
      for (const s of rows) if (s?.id) this.#sessions.set(s.id, s);
      // Continue the id sequence past anything restored, so a restart cannot
      // mint an id that already exists.
      for (const id of this.#sessions.keys()) {
        const n = Number(/^s_(\d+)_/.exec(id)?.[1] ?? 0);
        if (Number.isFinite(n) && n > this.#seq) this.#seq = n;
      }
    } catch {
      // A corrupt table must not stop the service from starting; it starts empty.
    }
  }

  #persist(): void {
    if (!this.#path) return;
    try {
      this.#file.write(this.#path!, JSON.stringify([...this.#sessions.values()]));
    } catch {
      // Persistence is not allowed to break a checkout (same rule as telemetry).
    }
  }

  /**
   * Sync from the harness, then re-evaluate expiry.
   *
   * The harness owns the truth (it is the thing watching the browser); this API
   * only translates it for the dashboard. Without this read the API reported
   * `preparing` forever while the browser sat at the captcha - a dashboard that
   * lies about the one thing it exists to show.
   */
  #sync(s: Session): void {
    if (!s.state_file) return;
    try {
      const raw = readStateFile(s.state_file);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { state?: string };
      if (parsed.state && STATES.includes(parsed.state as SessionState)) {
        // Never resurrect a terminal state, and never let the harness overwrite
        // a terminal state we already recorded (teardown beats a late write).
        if (!["expired", "failed", "completed", "outcome_unknown"].includes(s.state)) {
          s.state = parsed.state as SessionState;
        }
      }
    } catch { /* a missing or half-written file is not an error */ }
  }

  /** Re-evaluate expiry on every read. A stored "expired" flag can go stale. */
  #live(s: Session): Session {
    this.#sync(s);
    if (
      s.expires_at <= this.#now() &&
      !["completed", "failed", "expired", "outcome_unknown"].includes(s.state)
    ) {
      s.state = "expired";
      s.controller = null;
      s.reason = "expired";
    }
    return s;
  }

  list(facilitator: string): Session[] {
    return [...this.#sessions.values()]
      .filter((s) => s.facilitator === facilitator)
      .map((s) => this.#live(s));
  }

  get(id: string, facilitator: string): Session | null {
    const s = this.#sessions.get(id);
    // A wrong facilitator gets the SAME answer as a missing session: otherwise
    // the API becomes an oracle for which session ids exist.
    if (!s || s.facilitator !== facilitator) return null;
    return this.#live(s);
  }

  async create(order_id: string, facilitator: string): Promise<Session> {
    // One active session per order: two browsers on one order is exactly how a
    // duplicate purchase happens.
    for (const s of this.#sessions.values()) {
      const live = this.#live(s);
      if (
        live.order_id === order_id &&
        live.facilitator === facilitator &&
        !["completed", "failed", "expired"].includes(live.state)
      ) {
        throw new ApiError(409, "order already has an active session", {
          session_id: live.id,
          state: live.state,
        });
      }
    }
    // Id first: the edge vhost is keyed on it, and the launcher needs it while
    // the browser is still starting.
    const id = `s_${(++this.#seq).toString(36)}_${Math.abs(hash(order_id + facilitator)) % 100000}`;
    const spawned = await this.#spawn(order_id, facilitator, id);
    const session: Session = {
      id,
      order_id,
      facilitator,
      state: spawned.state ?? "preparing",
      created_at: this.#now(),
      expires_at: spawned.expires_at,
      novnc_url: spawned.novnc_url,
      state_file: spawned.state_file,
      controller: null,
      control_log: [],
    };
    this.#sessions.set(id, session);
    this.#persist();
    return session;
  }

  /** Acquire the single controller lease. Takeover must be asked for explicitly. */
  control(
    id: string,
    facilitator: string,
    controller: string,
    takeover = false,
  ): Session {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    if (!CONTROLLABLE.has(s.state)) {
      throw new ApiError(409, `session is not controllable in state '${s.state}'`, {
        state: s.state,
      });
    }
    if (s.controller && s.controller.id !== controller && !takeover) {
      throw new ApiError(409, "session already controlled on another device", {
        held_by_since: s.controller.since,
      });
    }
    const isTakeover = Boolean(s.controller && s.controller.id !== controller);
    if (isTakeover) this.revokeGrants(id);   // the old controller's access dies now
    s.controller = { id: controller, since: this.#now() };
    s.control_log.push({ controller, at: this.#now(), takeover: isTakeover });
    this.#persist();
    return s;
  }

  release(id: string, facilitator: string, controller: string): Session {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    if (s.controller?.id === controller) {
      s.controller = null;
      this.revokeGrants(id);
    }
    this.#persist();
    return s;
  }

  /** Issue an edge grant for the current controller. Only the holder may. */
  issueGrant(id: string, facilitator: string, controller: string, ttlMs = 120_000): Grant {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    if (!s.controller || s.controller.id !== controller) {
      // You cannot mint access you do not hold.
      throw new ApiError(403, "not the current controller");
    }
    // One grant per (session, controller): re-issuing invalidates the old one, so
    // a stale tab cannot keep a parallel grant alive.
    for (const [tok, g] of this.#grants) {
      if (g.session_id === id && g.controller === controller) this.#grants.delete(tok);
    }
    const token = randomToken();
    const grant: Grant = {
      token,
      session_id: id,
      controller,
      expires_at: this.#now() + ttlMs,
    };
    this.#grants.set(token, grant);
    return grant;
  }

  /** The edge's only question: may this request reach THIS session's browser? */
  authorize(token: string | null, sessionId: string): Grant | null {
    if (!token) return null;
    const g = this.#grants.get(token);
    if (!g) return null;
    if (g.session_id !== sessionId) return null;   // a grant is one session only
    if (g.expires_at <= this.#now()) {
      this.#grants.delete(token);
      return null;
    }
    // A grant dies with its session: an expired or torn-down session must not
    // leave a verifiable grant behind.
    const s = this.#live(this.#sessions.get(sessionId) as Session) ?? null;
    if (!s) return null;
    if (["expired", "failed", "completed"].includes(s.state)) return null;
    return g;
  }

  /** Drop every grant for a session (release, takeover, teardown, expiry). */
  revokeGrants(sessionId: string): number {
    let n = 0;
    for (const [tok, g] of this.#grants) {
      if (g.session_id === sessionId) {
        this.#grants.delete(tok);
        n++;
      }
    }
    return n;
  }

  remove(id: string, facilitator: string): void {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    // Teardown must dismiss live control too: removing a route does not drop an
    // already-open WebSocket, and a stale lease would outlive the browser.
    s.controller = null;
    s.state = "expired";
    s.reason = "torn down";
    this.revokeGrants(id);
    this.#sessions.delete(id);
    this.#persist();
  }
}

export class ApiError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Public projection: never leak internal topology or the capability URL to a list. */
export function publicView(s: Session, includeUrl = false) {
  return {
    session_id: s.id,
    order_id: s.order_id,
    state: s.state,
    created_at: new Date(s.created_at).toISOString(),
    expires_at: new Date(s.expires_at).toISOString(),
    controllable: CONTROLLABLE.has(s.state),
    controller: s.controller ? { since: s.controller.since } : null,
    ...(s.reason ? { reason: s.reason } : {}),
    ...(includeUrl && s.novnc_url ? { novnc_url: s.novnc_url } : {}),
  };
}

/**
 * Pure request handler — no server, no globals. Tests drive this directly, so
 * the auth and lease rules are verified without binding a port.
 */
export async function handle(
  req: Request,
  store: SessionStore,
  ctx: ApiContext,
): Promise<Response> {
  const url0 = new URL(req.url);
  const path0 = url0.pathname.replace(/^\/+|\/+$/g, "");

  // ---- THE EDGE CHECK -----------------------------------------------------
  // Caddy `forward_auth` calls this on EVERY request, including the WebSocket
  // upgrade, so the browser only reaches noVNC with a live grant. No facilitator
  // bearer token here on purpose: the edge has the grant, not the human's login.
  if (path0 === "edge/authorize") {
    const sid = url0.searchParams.get("session") ?? "";
    const bearer = (req.headers.get("x-cvm-grant") ?? "").trim();
    const cookie = req.headers.get("cookie") ?? "";
    const fromCookie = /(?:^|;\s*)cvm_grant=([0-9a-f]{8,})/.exec(cookie)?.[1] ?? "";
    const g = store.authorize(bearer || fromCookie, sid);
    if (!g) {
      return new Response("denied", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    // 200 with no body is what forward_auth expects to allow the request through.
    return new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store", "x-cvm-controller": "granted" },
    });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const facilitator = token ? ctx.tokens.get(token) : undefined;
  if (!facilitator) {
    return json(401, { error: "unauthorized", hint: "Bearer token required" });
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const m = req.method;

  try {
    // POST /sessions
    if (parts[0] === "sessions" && parts.length === 1 && m === "POST") {
      const body = await req.json().catch(() => ({})) as { order_id?: string };
      if (!body.order_id) return json(400, { error: "order_id required" });
      const s = await store.create(body.order_id, facilitator);
      // The capability URL is returned ONCE, to its owner, on creation.
      return json(201, publicView(s, true));
    }

    if (parts[0] === "sessions" && parts.length === 1 && m === "GET") {
      return json(200, { sessions: store.list(facilitator).map((s) => publicView(s)) });
    }

    // /sessions/:id[/control]
    if (parts[0] === "sessions" && parts.length >= 2) {
      const id = parts[1] as string;

      if (parts.length === 2 && m === "GET") {
        const s = store.get(id, facilitator);
        if (!s) return json(404, { error: "no such session" });
        // Re-reading your own session re-issues the URL: a reloaded dashboard tab
        // must not lose the ability to finish an order it legitimately owns.
        return json(200, publicView(s, true));
      }

      if (parts.length === 3 && parts[2] === "control" && m === "POST") {
        const body = await req.json().catch(() => ({})) as {
          controller?: string;
          takeover?: boolean;
        };
        if (!body.controller) return json(400, { error: "controller required" });
        const s = store.control(id, facilitator, body.controller, body.takeover === true);
        const grant = store.issueGrant(id, facilitator, body.controller, ctx.grant_ttl_ms);
        return json(200, {
          ...publicView(s, true),
          // Short-lived: the viewer must refresh it. It is not the session URL and
          // it is useless against any other session.
          grant: grant.token,
          grant_expires_at: new Date(grant.expires_at).toISOString(),
          grant_how: "send as Cookie: cvm_grant=<token> (preferred) or X-CVM-Grant",
        });
      }

      if (parts.length === 3 && parts[2] === "control" && m === "DELETE") {
        const body = await req.json().catch(() => ({})) as { controller?: string };
        if (!body.controller) return json(400, { error: "controller required" });
        return json(200, publicView(store.release(id, facilitator, body.controller)));
      }

      if (parts.length === 2 && m === "DELETE") {
        store.remove(id, facilitator);
        return json(204, null);
      }
    }

    return json(404, { error: "no such route" });
  } catch (e) {
    if (e instanceof ApiError) {
      return json(e.status, { error: e.message, ...(e.detail ? { detail: e.detail } : {}) });
    }
    return json(500, { error: "internal error" });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
