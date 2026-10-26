/**
 * The credential that replaces a pasted static token. Every rejection here is a
 * way an unapproved device could otherwise act as a facilitator.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { FacilitatorAuth, type NostrEventLike } from "./facilitator_auth.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);
const URL = "https://cvm.orangesync.tech/auth/verify";

let now = 1_700_000_000_000;
let auth: FacilitatorAuth;

/** Signs as `pubkey` - only the keys we bless verify. */
const signer = (pubkey: string) => ({
  verify: (e: NostrEventLike) => e.pubkey === pubkey,
  hash: (e: NostrEventLike) => `h:${e.pubkey}:${e.content}:${JSON.stringify(e.tags)}`,
});

function event(over: Partial<NostrEventLike> = {}, pubkey = ALICE): NostrEventLike {
  const e: NostrEventLike = {
    pubkey, kind: 27235, created_at: Math.floor(now / 1000), content: "",
    tags: [["u", URL], ["method", "POST"], ["challenge", ""]],
    sig: "sig",
    ...over,
  };
  e.id = signer(pubkey).hash(e); // a correctly-hashed event unless a test breaks it
  return e;
}

beforeEach(() => {
  now = 1_700_000_000_000;
  const s = signer(ALICE);
  auth = new FacilitatorAuth({
    allowlist: new Set([ALICE]),
    verify: s.verify,
    hash: s.hash,
    now: () => now,
    expected_url: URL,
  });
});

const withChallenge = (nonce: string, pubkey = ALICE) =>
  event({ tags: [["u", URL], ["method", "POST"], ["challenge", nonce]] }, pubkey);

describe("the happy path", () => {
  test("an approved key, signing the issued nonce, gets a token", () => {
    const c = auth.challenge();
    const r = auth.redeem(withChallenge(c.nonce));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.npub).toBe(ALICE);
      expect(auth.verifyToken(r.token)?.npub).toBe(ALICE);
    }
  });

  test("the token expires and then stops working", () => {
    const c = auth.challenge();
    const r = auth.redeem(withChallenge(c.nonce));
    expect(r.ok).toBe(true);
    now += 13 * 3600_000; // past the 12h TTL
    if (r.ok) expect(auth.verifyToken(r.token)).toBeNull();
  });
});

describe("replay and freshness", () => {
  test("a nonce can only be redeemed once", () => {
    const c = auth.challenge();
    const ev = withChallenge(c.nonce);
    expect(auth.redeem(ev).ok).toBe(true);
    expect(auth.redeem(ev).ok).toBe(false); // replay
  });

  test("a bad signature burns the nonce rather than allowing a retry", () => {
    const c = auth.challenge();
    expect(auth.redeem(withChallenge(c.nonce, MALLORY)).ok).toBe(false);
    // Same nonce, now correct: still refused, because the first attempt consumed it.
    expect(auth.redeem(withChallenge(c.nonce)).ok).toBe(false);
  });

  test("an expired challenge is refused", () => {
    const c = auth.challenge();
    now += 200_000; // past the 120s challenge TTL
    expect(auth.redeem(withChallenge(c.nonce)).ok).toBe(false);
  });

  test("an invented nonce is refused", () => {
    expect(auth.redeem(withChallenge("deadbeef")).ok).toBe(false);
  });

  test("a stale signed event is refused", () => {
    const c = auth.challenge();
    const ev = withChallenge(c.nonce);
    ev.created_at = Math.floor(now / 1000) - 3600; // an hour old
    ev.id = signer(ALICE).hash(ev);
    expect(auth.redeem(ev).ok).toBe(false);
  });
});

describe("authorization", () => {
  test("an unknown npub is refused, with the same reason as an unapproved one", () => {
    const s = signer(MALLORY);
    const other = new FacilitatorAuth({
      allowlist: new Set([ALICE]), verify: s.verify, hash: s.hash,
      now: () => now, expected_url: URL,
    });
    const c = other.challenge();
    const r = other.redeem(withChallenge(c.nonce, MALLORY));
    expect(r.ok).toBe(false);
    // Not a membership oracle: the reason does not distinguish unknown from
    // not-yet-approved.
    if (!r.ok) expect(r.reason).toContain("not approved");
  });

  test("an event signed for a different url is refused", () => {
    const c = auth.challenge();
    const ev = event({ tags: [["u", "https://evil.example/auth/verify"], ["challenge", c.nonce]], content: "" });
    expect(auth.redeem(ev).ok).toBe(false);
  });

  test("wrong kind is refused", () => {
    const c = auth.challenge();
    const ev = withChallenge(c.nonce);
    ev.kind = 1;
    ev.id = signer(ALICE).hash(ev);
    expect(auth.redeem(ev).ok).toBe(false);
  });

  test("a tampered event (id not matching content) is refused", () => {
    const c = auth.challenge();
    const ev = withChallenge(c.nonce);
    ev.content = "tampered"; // id now stale
    expect(auth.redeem(ev).ok).toBe(false);
  });
});

describe("revocation", () => {
  test("one device can be revoked without touching another", () => {
    const phone = auth.redeem(withChallenge(auth.challenge().nonce));
    const laptop = auth.redeem(withChallenge(auth.challenge().nonce));
    expect(phone.ok && laptop.ok).toBe(true);
    if (!phone.ok || !laptop.ok) return;

    auth.revoke(phone.token);
    expect(auth.verifyToken(phone.token)).toBeNull();
    expect(auth.verifyToken(laptop.token)?.npub).toBe(ALICE);
  });

  test("revoking an identity kills every token it holds", () => {
    const a = auth.redeem(withChallenge(auth.challenge().nonce));
    const b = auth.redeem(withChallenge(auth.challenge().nonce));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    expect(auth.revokeNpub(ALICE)).toBe(2);
    expect(auth.verifyToken(a.token)).toBeNull();
    expect(auth.verifyToken(b.token)).toBeNull();
  });

  test("an empty allowlist means nobody, which is the safe default", () => {
    const s = signer(ALICE);
    const nobody = new FacilitatorAuth({
      allowlist: new Set(), verify: s.verify, hash: s.hash,
      now: () => now, expected_url: URL,
    });
    expect(nobody.redeem(withChallenge(nobody.challenge().nonce)).ok).toBe(false);
  });
});
