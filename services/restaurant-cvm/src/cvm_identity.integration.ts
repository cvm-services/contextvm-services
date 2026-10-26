/**
 * Real signatures, real forgery attempts. The unit tests prove the RULES; this
 * proves the rules hold against actual secp256k1 rather than a stub that agrees
 * with whatever it is given.
 *
 *   deno test --allow-all --node-modules-dir=manual src/cvm_identity.integration.ts
 *
 * NOT named *.test.ts on purpose: it imports npm:nostr-tools, which bun cannot
 * resolve, and bun's default glob would otherwise fail the whole suite on a file
 * it was never meant to run.
 */
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from "npm:nostr-tools";
import { resolveClientPubkey } from "./cvm_identity.ts";

const sk = () => generateSecretKey();
// The resolver accepts PARTIAL events (it must check for missing fields), while
// verifyEvent demands a complete one. Adapt at the boundary where a complete
// event exists - the same shape used in server.ts.
const verify = (e: unknown) => verifyEvent(e as Parameters<typeof verifyEvent>[0]);
const hash = (e: unknown) => getEventHash(e as never);
const pk = (k: Uint8Array) => getPublicKey(k);
const sign = (k: Uint8Array, content: string, tags: string[][] = []) =>
  finalizeEvent({ kind: 4, created_at: 1_700_000_000, tags, content }, k);

Deno.test("a genuinely signed envelope from one key is accepted", () => {
  const alice = sk();
  const outer = sign(alice, "ciphertext");
  const inner = sign(alice, JSON.stringify({ method: "menu" }));
  const r = resolveClientPubkey(outer, inner, verify, hash);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  if (r.pubkey !== pk(alice)) throw new Error("wrong identity resolved");
});

Deno.test("an inner event claiming another npub is rejected", () => {
  const mallory = sk();
  const alice = sk();
  // Mallory's envelope is perfectly valid - her own signature, her own key.
  const outer = sign(mallory, "ciphertext");
  // Inside, she claims to be Alice. This used to be trusted verbatim.
  const inner = sign(alice, JSON.stringify({ method: "order" }));
  const r = resolveClientPubkey(outer, inner, verify, hash);
  if (r.ok) throw new Error("IMPERSONATION ACCEPTED - inner pubkey was trusted");
  if (!r.reason.includes("impersonation")) throw new Error(`unexpected reason: ${r.reason}`);
});

Deno.test("a tampered inner content fails its own signature", () => {
  const alice = sk();
  const outer = sign(alice, "ciphertext");
  const inner = sign(alice, JSON.stringify({ method: "menu" }));
  const tampered = { ...inner, content: JSON.stringify({ method: "order", free: true }) };
  const r = resolveClientPubkey(outer, tampered, verify, hash);
  if (r.ok) throw new Error("TAMPERED INNER EVENT ACCEPTED");
});

Deno.test("a tampered outer envelope is rejected", () => {
  const alice = sk();
  const outer = sign(alice, "ciphertext");
  const tampered = { ...outer, content: "different ciphertext" };
  const r = resolveClientPubkey(tampered, { content: "{}" }, verify, hash);
  if (r.ok) throw new Error("TAMPERED OUTER EVENT ACCEPTED");
});

Deno.test("an unsigned outer envelope is rejected", () => {
  const alice = sk();
  const inner = sign(alice, "{}");
  const r = resolveClientPubkey({ pubkey: pk(alice) }, inner, verify, hash);
  if (r.ok) throw new Error("UNSIGNED ENVELOPE ACCEPTED");
});
