/**
 * Device key for the facilitator app.
 *
 * The pattern cashu.me uses for a wallet, applied to identity: the key is made on
 * the device, stored on the device, and never leaves it. Nothing secret is typed,
 * pasted, or delivered through a chat channel.
 *
 * HONEST LIMIT: browsers have no secp256k1 in WebCrypto, so this key cannot be a
 * non-extractable CryptoKey - it sits in IndexedDB as bytes. That is the same
 * exposure cashu.me accepts for money. It is weaker than a hardware signer and
 * stronger than a shared token that never expires: unique per device, revocable
 * individually, and worthless to anyone who cannot run script on this origin.
 */
import { schnorr, sha256, bytesToHex, hexToBytes } from "/vendor/noble.js";

const DB_NAME = "cvm_facilitator";
const STORE = "keys";
const SK = "sk";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** A valid secp256k1 scalar: retry on the (vanishing) invalid case. */
function freshSecret() {
  for (let i = 0; i < 8; i++) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    try {
      schnorr.getPublicKey(b); // throws if out of range
      return b;
    } catch { /* try again */ }
  }
  throw new Error("could not generate a valid key");
}

export async function hasKey() {
  return (await idbGet(SK)) != null;
}

export async function createKey() {
  const sk = freshSecret();
  await idbSet(SK, sk);
  return await getPubkey();
}

export async function getPubkey() {
  const sk = await idbGet(SK);
  if (!sk) return null;
  return bytesToHex(schnorr.getPublicKey(sk));
}

export async function forgetKey() {
  await idbDel(SK);
}

/** NIP-01 id: sha256 of the canonical serialisation, then BIP-340 schnorr. */
export async function signEvent({ kind, tags = [], content = "", created_at }) {
  const sk = await idbGet(SK);
  if (!sk) throw new Error("no key on this device");
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const evt = {
    pubkey,
    kind,
    created_at: created_at ?? Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  // NIP-01 canonical order: [0, pubkey, created_at, kind, tags, content].
  // Getting these two middle fields the wrong way round still produces a
  // beautiful, well-formed signature - over a payload nobody will ever verify.
  const serial = JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
  const id = bytesToHex(sha256(new TextEncoder().encode(serial)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { ...evt, id, sig };
}

/**
 * Prove this device's identity and receive a short-lived token.
 *
 * The URL and method go inside the signed event, so an event minted for another
 * site cannot be replayed here.
 */
export async function signIn(apiBase, url, method = "POST") {
  const chRes = await fetch(`${apiBase}/auth/challenge`, { cache: "no-store" });
  if (!chRes.ok) throw new Error(`challenge failed: ${chRes.status}`);
  const { nonce } = await chRes.json();

  const evt = await signEvent({
    kind: 27235,
    tags: [["u", url], ["method", method], ["challenge", nonce]],
    content: "",
  });

  const res = await fetch(`${apiBase}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evt),
  });
  if (!res.ok) throw new Error("this device is not approved as a facilitator");
  const data = await res.json();
  return { token: data.token, npub: data.npub, expires_at: data.expires_at };
}
