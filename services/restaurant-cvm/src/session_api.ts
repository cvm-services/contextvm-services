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
  /** Current controller, if any. Single-holder. */
  controller: { id: string; since: number } | null;
  /** Audit trail: every control acquisition, including takeovers. */
  control_log: { controller: string; at: number; takeover: boolean }[];
  reason?: string;
}

export interface ApiContext {
  /** Token -> facilitator id. Supplied by config; never literal in code. */
  tokens: Map<string, string>;
  now?: () => number;
}

export type SpawnResult = {
  novnc_url: string;
  expires_at: number;
  state?: SessionState;
};

/** Injected so tests never touch a real browser, and production can swap it. */
export type Spawner = (order_id: string, facilitator: string) => Promise<SpawnResult>;

export class SessionStore {
  #sessions = new Map<string, Session>();
  #spawn: Spawner;
  #now: () => number;
  #seq = 0;

  constructor(spawn: Spawner, now: () => number = () => Date.now()) {
    this.#spawn = spawn;
    this.#now = now;
  }

  /** Re-evaluate expiry on every read. A stored "expired" flag can go stale. */
  #live(s: Session): Session {
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
    const spawned = await this.#spawn(order_id, facilitator);
    const id = `s_${(++this.#seq).toString(36)}_${Math.abs(hash(order_id + facilitator)) % 100000}`;
    const session: Session = {
      id,
      order_id,
      facilitator,
      state: spawned.state ?? "preparing",
      created_at: this.#now(),
      expires_at: spawned.expires_at,
      novnc_url: spawned.novnc_url,
      controller: null,
      control_log: [],
    };
    this.#sessions.set(id, session);
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
    s.controller = { id: controller, since: this.#now() };
    s.control_log.push({ controller, at: this.#now(), takeover: isTakeover });
    return s;
  }

  release(id: string, facilitator: string, controller: string): Session {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    if (s.controller?.id === controller) s.controller = null;
    return s;
  }

  remove(id: string, facilitator: string): void {
    const s = this.get(id, facilitator);
    if (!s) throw new ApiError(404, "no such session");
    // Teardown must dismiss live control too: removing a route does not drop an
    // already-open WebSocket, and a stale lease would outlive the browser.
    s.controller = null;
    s.state = "expired";
    s.reason = "torn down";
    this.#sessions.delete(id);
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
        return json(200, publicView(s, true));
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
