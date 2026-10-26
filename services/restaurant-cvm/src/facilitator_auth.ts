/**
 * Facilitator auth: prove an npub, get a short-lived token.
 *
 * REPLACES the static shared secret that is currently pasted into the PWA. Three
 * problems with that secret, and how each is answered here:
 *
 *   shared        -> every facilitator gets their own key; revocation is per device
 *   infinite      -> tokens expire (12h) and are revocable individually
 *   carried       -> nothing secret travels through chat, clipboard or a URL; the
 *                    device proves possession of a key it generated itself
 *
 * The credential is a NIP-98 event (kind 27235) signed over a server-issued
 * nonce. That is deliberately the same primitive a browser signer and a NIP-46
 * bunker can both produce, so the device choice does not change this file.
 *
 * WHAT THIS IS NOT: it does not establish that the npub belongs to a trusted
 * person. That is the allowlist's job, and the allowlist is the operator's.
 */

export interface NostrEventLike {
  id?: string;
  pubkey?: string;
  kind?: number;
  created_at?: number;
  tags?: string[][];
  content?: string;
  sig?: string;
}

export type VerifyEvent = (event: NostrEventLike) => unknown;
export type EventHash = (event: NostrEventLike) => string;

export interface AuthOptions {
  /** npubs allowed to act as facilitators. Empty = nobody, which is the safe default. */
  allowlist: Set<string>;
  verify: VerifyEvent;
  hash: EventHash;
  now?: () => number;
  /** How long a challenge is valid. Short: it only needs to survive a signature. */
  challenge_ttl_ms?: number;
  /** How long a session token lasts. Long enough for a shift, short enough to matter. */
  token_ttl_ms?: number;
  /** Clock skew tolerated on the signed event. */
  skew_ms?: number;
  /** The URL the signed event must name. */
  expected_url: string;
}

export interface Challenge {
  nonce: string;
  expires_at: number;
}

export interface IssuedToken {
  token: string;
  npub: string;
  expires_at: number;
}

export type AuthFailure = { ok: false; reason: string };
export type AuthSuccess = { ok: true; token: string; npub: string; expires_at: number };

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class FacilitatorAuth {
  #challenges = new Map<string, number>(); // nonce -> expiry
  #tokens = new Map<string, { npub: string; expires_at: number }>();
  #now: () => number;
  #opts: AuthOptions;

  constructor(opts: AuthOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Step 1: a nonce the device must sign. Single use. */
  challenge(): Challenge {
    const nonce = randomHex(16);
    const expires_at = this.#now() + (this.#opts.challenge_ttl_ms ?? 120_000);
    this.#challenges.set(nonce, expires_at);
    return { nonce, expires_at };
  }

  /**
   * Step 2: verify the signed challenge and issue a token.
   *
   * Every failure returns a reason but never a token, and the nonce is consumed
   * on the FIRST attempt - valid or not - so a captured event cannot be replayed
   * and a wrong signature cannot be retried against the same nonce.
   */
  redeem(event: NostrEventLike): AuthSuccess | AuthFailure {
    const tags = (event?.tags ?? []).filter((t) => Array.isArray(t) && t.length >= 2);
    const challengeTag = tags.find((t) => t[0] === "challenge")?.[1] ?? "";
    const urlTag = tags.find((t) => t[0] === "u")?.[1] ?? "";
    const methodTag = tags.find((t) => t[0] === "method")?.[1] ?? "";

    // Consume first: a replayed nonce must fail even if the first attempt was bad.
    const expiry = this.#challenges.get(challengeTag);
    this.#challenges.delete(challengeTag);

    if (!challengeTag || expiry === undefined) return { ok: false, reason: "unknown or already used challenge" };
    if (expiry <= this.#now()) return { ok: false, reason: "challenge expired" };

    if (!event?.pubkey || !event?.sig || !event?.id) return { ok: false, reason: "event is not signed" };
    if (event.kind !== 27235) return { ok: false, reason: `wrong event kind: ${event.kind}` };

    // Signature over a stale id is not a signature over this message.
    let idOk = false;
    try {
      idOk = this.#opts.hash(event) === event.id;
    } catch {
      idOk = false;
    }
    if (!idOk) return { ok: false, reason: "event id does not match its content" };

    let sigOk = false;
    try {
      sigOk = Boolean(this.#opts.verify(event));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return { ok: false, reason: "bad signature" };

    const skew = this.#opts.skew_ms ?? 60_000;
    const at = Number(event.created_at ?? 0) * 1000;
    if (!Number.isFinite(at) || Math.abs(this.#now() - at) > skew) {
      return { ok: false, reason: "event timestamp outside the accepted window" };
    }

    if (urlTag !== this.#opts.expected_url) return { ok: false, reason: "event is for a different url" };
    if (methodTag && methodTag.toUpperCase() !== "POST") return { ok: false, reason: "event is for a different method" };

    if (!this.#opts.allowlist.has(event.pubkey)) {
      // Same reason whether the npub is unknown or not yet approved: do not turn
      // this endpoint into a membership oracle.
      return { ok: false, reason: "this identity is not approved as a facilitator" };
    }

    const token = randomHex(32);
    const expires_at = this.#now() + (this.#opts.token_ttl_ms ?? 12 * 3600_000);
    this.#tokens.set(token, { npub: event.pubkey, expires_at });
    return { ok: true, token, npub: event.pubkey, expires_at };
  }

  /** Who does this token belong to, if anyone? Expired tokens are dropped. */
  verifyToken(token: string | null | undefined): { npub: string; expires_at: number } | null {
    if (!token) return null;
    const t = this.#tokens.get(token);
    if (!t) return null;
    if (t.expires_at <= this.#now()) {
      this.#tokens.delete(token);
      return null;
    }
    return t;
  }

  /** Revoke one device without touching the others. */
  revoke(token: string): boolean {
    return this.#tokens.delete(token);
  }

  /** Remove an identity entirely: every token it holds dies at once. */
  revokeNpub(npub: string): number {
    let n = 0;
    for (const [tok, t] of this.#tokens) {
      if (t.npub === npub) {
        this.#tokens.delete(tok);
        n++;
      }
    }
    return n;
  }

  /** Housekeeping for long-running processes. */
  sweep(): void {
    const now = this.#now();
    for (const [n, exp] of this.#challenges) if (exp <= now) this.#challenges.delete(n);
    for (const [t, v] of this.#tokens) if (v.expires_at <= now) this.#tokens.delete(t);
  }
}
