/**
 * Who is on the other end of a ContextVM message?
 *
 * The transport hands us two things: an OUTER nostr event (the envelope the relay
 * carried) and, inside its encrypted content, an INNER event (the MCP request as
 * the client signed it). Until now the server used
 *
 *     const clientPubkey = innerEvent.pubkey || event.pubkey;
 *
 * with no verification at all. That is safe only while the pubkey decides nothing
 * but where to send the reply. The moment facilitator identity is derived from it
 * - which is the whole point of getting rid of static tokens - it becomes
 * "anyone can be anyone".
 *
 * Two independent checks, both cheap:
 *
 *   1. The OUTER event must carry a valid signature. nip44 makes forgery hard in
 *      practice (you need the sender's secret to produce ciphertext that
 *      decrypts), but implicit properties are not a verification step and do not
 *      survive a change of transport.
 *   2. The INNER pubkey must EQUAL the outer one. The inner event is plain JSON
 *      inside the ciphertext: its `pubkey` is a claim, and a claim from inside a
 *      message is not an identity.
 *
 * Anything that fails is rejected rather than downgraded to a default, because a
 * fallback here is precisely how impersonation gets in.
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

export type IdentityResult =
  | { ok: true; pubkey: string }
  | { ok: false; reason: string };

/**
 * Injected so tests need no crypto and no relay.
 *
 * Returns `unknown` on purpose: nostr-tools' verifyEvent is a TYPE PREDICATE
 * (`event is VerifiedEvent`), which is not assignable to a `=> boolean` slot.
 * Only truthiness matters here, so accepting any return keeps the real verifier
 * usable without a cast at every call site.
 */
export type VerifyEvent = (event: NostrEventLike) => unknown;

/**
 * Computes the event id from its content. Injected for the same reason as the
 * verifier: no crypto in unit tests.
 *
 * WHY IT IS NOT OPTIONAL IN PRACTICE: `verifyEvent` checks a signature over
 * `event.id`. If `id` is not recomputed, an attacker can copy a valid event,
 * change `content`, and keep `id` + `sig` - the signature then vouches for a hash
 * that no longer describes the message. Measured: with `verifyEvent` alone, a
 * tampered event was ACCEPTED. Passing a hash function closes that.
 */
export type EventHash = (event: NostrEventLike) => string;

function idMatches(e: NostrEventLike, hash: EventHash): boolean {
  if (!e?.id) return false;
  try {
    return hash(e) === e.id;
  } catch {
    return false;
  }
}

export function resolveClientPubkey(
  outer: NostrEventLike,
  inner: NostrEventLike,
  verify: VerifyEvent,
  hash?: EventHash,
): IdentityResult {
  if (!outer?.pubkey) return { ok: false, reason: "outer event has no pubkey" };
  if (!outer?.sig) return { ok: false, reason: "outer event is unsigned" };

  let outerValid = false;
  try {
    outerValid = Boolean(verify(outer));
  } catch {
    outerValid = false;
  }
  if (!outerValid) return { ok: false, reason: "outer signature invalid" };

  // The signature covers `id`, not the content. Without this, a copied event with
  // edited content keeps a valid signature over a stale hash.
  if (hash && !idMatches(outer, hash)) {
    return { ok: false, reason: "outer event id does not match its content (tampered)" };
  }

  if (!inner?.pubkey) {
    // Older clients omit the inner pubkey; trusting the outer one is acceptable
    // ONLY because the outer signature is already verified above.
    return { ok: true, pubkey: outer.pubkey };
  }

  if (inner.pubkey !== outer.pubkey) {
    return {
      ok: false,
      reason: "inner pubkey does not match the verified outer pubkey (possible impersonation)",
    };
  }

  // The inner event is signed too; verify it when it claims to be signed, so a
  // tampered-but-copied inner event cannot ride on a valid outer envelope.
  if (hash && !idMatches(inner, hash)) {
    return { ok: false, reason: "inner event id does not match its content (tampered)" };
  }

  if (inner.sig) {
    let innerValid = false;
    try {
      innerValid = Boolean(verify(inner));
    } catch {
      innerValid = false;
    }
    if (!innerValid) return { ok: false, reason: "inner signature invalid" };
  }

  return { ok: true, pubkey: outer.pubkey };
}
