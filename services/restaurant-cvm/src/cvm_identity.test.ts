/**
 * Identity on the CVM transport. Every failing case here is an impersonation that
 * would otherwise be invisible: the request would look completely normal.
 */
import { describe, expect, test } from "bun:test";
import { resolveClientPubkey, type NostrEventLike, type VerifyEvent as Verify } from "./cvm_identity.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);

/** Verify only the keys we say are genuine - stands in for secp256k1. */
const verifyOnly = (...genuine: string[]) => (e: NostrEventLike) => genuine.includes(String(e.pubkey));

const outer = (pubkey = ALICE): NostrEventLike => ({ pubkey, sig: "sig", kind: 4, content: "..." });

describe("the happy path", () => {
  test("a verified outer envelope with no inner pubkey yields the outer key", () => {
    const r = resolveClientPubkey(outer(), { content: "{}" }, verifyOnly(ALICE));
    expect(r).toEqual({ ok: true, pubkey: ALICE });
  });

  test("an inner event naming the same key is accepted", () => {
    const r = resolveClientPubkey(outer(), { pubkey: ALICE, sig: "s2" }, verifyOnly(ALICE));
    expect(r).toEqual({ ok: true, pubkey: ALICE });
  });
});

describe("impersonation", () => {
  test("an inner event claiming ANOTHER identity is rejected", () => {
    // Mallory holds her own key (so the envelope verifies), but the inner event
    // says it is Alice. This is the exact shape that used to be trusted.
    const r = resolveClientPubkey(outer(MALLORY), { pubkey: ALICE }, verifyOnly(MALLORY));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("impersonation");
  });

  test("an unsigned outer event is rejected", () => {
    const r = resolveClientPubkey({ pubkey: ALICE }, { pubkey: ALICE }, verifyOnly(ALICE));
    expect(r.ok).toBe(false);
  });

  test("a forged outer signature is rejected", () => {
    // Signature does not verify against the claimed key.
    const r = resolveClientPubkey(outer(ALICE), { pubkey: ALICE }, verifyOnly(MALLORY));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("outer signature invalid");
  });

  test("a tampered inner event with a bad signature is rejected", () => {
    const verify: Verify = (e) => (e.sig === "s2" ? false : verifyOnly(ALICE)(e));
    const r = resolveClientPubkey(outer(), { pubkey: ALICE, sig: "s2" }, verify);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inner signature invalid");
  });

  test("an outer event with no pubkey is rejected", () => {
    expect(resolveClientPubkey({ sig: "s" }, { pubkey: ALICE }, verifyOnly(ALICE)).ok).toBe(false);
  });
});

describe("the id must describe the content", () => {
  // verifyEvent checks a signature over `id`. If `id` is not recomputed, a copied
  // event with edited content keeps a valid signature over a stale hash - measured
  // as a real acceptance before this check existed.
  const hashOf = (content: string) => (e: NostrEventLike) => `h:${e.content}`;

  test("an event whose id does not match its content is rejected", () => {
    const stale = { pubkey: ALICE, sig: "s", id: "h:original", content: "tampered" };
    const r = resolveClientPubkey(stale, { content: "{}" }, verifyOnly(ALICE), hashOf("x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("tampered");
  });

  test("a matching id is accepted", () => {
    const good = { pubkey: ALICE, sig: "s", id: "h:original", content: "original" };
    expect(resolveClientPubkey(good, { content: "{}" }, verifyOnly(ALICE), hashOf("x")).ok).toBe(true);
  });

  test("a tampered inner event is rejected even with a valid outer envelope", () => {
    const outer = { pubkey: ALICE, sig: "s", id: "h:orig", content: "orig" };
    const inner = { pubkey: ALICE, id: "h:orig", content: "changed" };
    const r = resolveClientPubkey(outer, inner, verifyOnly(ALICE), hashOf("x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inner event id");
  });

  test("a throwing hash function rejects rather than accepting", () => {
    const outer = { pubkey: ALICE, sig: "s", id: "h:orig", content: "orig" };
    const boom = () => { throw new Error("hash failed"); };
    expect(resolveClientPubkey(outer, { content: "{}" }, verifyOnly(ALICE), boom).ok).toBe(false);
  });
});

describe("failure is never a downgrade", () => {
  test("a throwing verifier rejects instead of falling back to the claimed key", () => {
    const boom = () => { throw new Error("crypto exploded"); };
    const r = resolveClientPubkey(outer(), { pubkey: ALICE }, boom);
    expect(r.ok).toBe(false);
  });

  test("garbage inputs do not throw", () => {
    expect(() => resolveClientPubkey({} as NostrEventLike, {} as NostrEventLike, verifyOnly())).not.toThrow();
    expect(resolveClientPubkey({} as NostrEventLike, {} as NostrEventLike, verifyOnly()).ok).toBe(false);
  });
});

