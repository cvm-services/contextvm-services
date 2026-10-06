/**
 * key-text decoding — the shape of `nip19.decode`'s result.
 *
 * Regression: `readKey` did `secretHex = d.data as string` for the nsec branch.
 * In nostr-tools >= 2, `decode("nsec1…").data` is a **Uint8Array** (32 bytes),
 * so that cast produced a non-hex value, the 64-hex guard rejected it, and
 * every `--key-file something.nsec` invocation died with
 * "key file is not 64-char hex or nsec" — the exact usage its own --help prints.
 * Only 64-char hex files worked, which is how it went unnoticed.
 *
 * The vector is the secp256k1 scalar 1 (public key = the generator point): a
 * published constant, tied to nothing, holding no funds or role. It is here so
 * the nsec path can be tested without committing key material that matters.
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nsecEncode } from "npm:nostr-tools/nip19";
import { keyTextToSecretHex } from "../tools/nostr.ts";

const SCALAR_ONE_HEX = "0".repeat(63) + "1";
const SCALAR_ONE_BYTES = new Uint8Array(32);
SCALAR_ONE_BYTES[31] = 1;
const SCALAR_ONE_NSEC = nsecEncode(SCALAR_ONE_BYTES);

Deno.test("a 64-char hex key passes through unchanged", () => {
  assertEquals(keyTextToSecretHex(SCALAR_ONE_HEX), SCALAR_ONE_HEX);
  assertEquals(keyTextToSecretHex(`${SCALAR_ONE_HEX}\n`), SCALAR_ONE_HEX);
});

Deno.test("an nsec1 key file decodes to its secret hex", () => {
  assertEquals(keyTextToSecretHex(SCALAR_ONE_NSEC), SCALAR_ONE_HEX);
  assertEquals(keyTextToSecretHex(`${SCALAR_ONE_NSEC}\n`), SCALAR_ONE_HEX);
});

Deno.test("anything else is refused with a stable message", () => {
  assertThrows(() => keyTextToSecretHex(""), Error, "empty");
  assertThrows(() => keyTextToSecretHex("nsec1notreally"), Error);
  assertThrows(() => keyTextToSecretHex("not-a-key"), Error, "not 64-char hex or nsec");
  // a valid npub is not a signing key
  assertThrows(() => keyTextToSecretHex("npub1lecq5zgff9gxvqrhg3a7m48qkw4uzj5za9fz0vcn46lc8dme3xzq9klwgp"), Error);
});
