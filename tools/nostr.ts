/**
 * nostr.ts — the small shared layer the emit-* CLIs use.
 *
 * Extracted from emit-venue-announcement.ts when a second emitter (reviews)
 * needed the same key handling, signing and publish loop. Behaviour is
 * unchanged: same key-file semantics, same 600 perms, same OK-waiting publish
 * with its explicit timeout (a relay that answers REQ but never emits OK is the
 * failure mode this loop exists to expose).
 */

import { finalizeEvent, generateSecretKey } from "npm:nostr-tools/pure";
import { decode as nip19Decode, npubEncode } from "npm:nostr-tools/nip19";

export function fail(msg: string): never {
  console.error("ERROR: " + msg);
  Deno.exit(1);
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`not hex: ${hex.slice(0, 16)}…`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface Identity {
  hex: string;
  npub: string;
}

/**
 * Read (or, when `create`, generate and persist) the signing key.
 * The file may hold 64-char hex or an nsec1… string. Created files are 0600.
 */
export async function readKey(keyFile: string, create: boolean): Promise<Identity> {
  const path = keyFile.startsWith("/") ? keyFile : `${Deno.cwd()}/${keyFile}`;
  let text = "";
  try {
    text = (await Deno.readTextFile(path)).trim();
  } catch {
    if (!create) fail(`key file '${keyFile}' not found (run without --dry-run to create it)`);
  }
  if (text) {
    let hex = text;
    if (text.startsWith("nsec")) {
      const d = nip19Decode(text);
      if (d.type !== "nsec") fail("key file is not an nsec");
      hex = d.data as string;
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) fail("key file is not 64-char hex or nsec");
    return { hex, npub: npubEncode(hex) };
  }
  const sk = generateSecretKey();
  const hex = Buffer.from(sk).toString("hex");
  await Deno.writeTextFile(path, hex + "\n", { mode: 0o600 });
  await Deno.chmod(path, 0o600);
  return { hex, npub: npubEncode(hex) };
}

export function signEvent(secretHex: string, template: Record<string, unknown>): unknown {
  return finalizeEvent(template as never, hexToBytes(secretHex));
}

/** Publish one event and report the relay's own OK verdict. */
export async function publish(
  relay: string,
  event: unknown,
): Promise<{ accepted: boolean; msg: string }> {
  const ws = new WebSocket(relay);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout connecting ${relay}`)), 15000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error(`error connecting ${relay}`));
    };
  });
  return new Promise<{ accepted: boolean; msg: string }>((resolve) => {
    ws.onmessage = (m) => {
      const data = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data));
      if (data[0] === "OK") resolve({ accepted: data[2] === true, msg: `${data[2]} ${data[3]}` });
    };
    ws.send(JSON.stringify(["EVENT", event]));
    setTimeout(() => resolve({ accepted: false, msg: "timeout awaiting OK" }), 10000);
  });
}

/** `--relays a,b` or repeated `--relays a --relays b`. */
export function relayList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return (raw as string[]).filter(Boolean);
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}
