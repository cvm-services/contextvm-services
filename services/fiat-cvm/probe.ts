/**
 * Live probe for the 2fiat CVM — a minimal CVM client that speaks the real wire
 * protocol (ephemeral key, gift-wrapped kind-25910 MCP requests, NIP-44).
 *
 *   deno run --allow-net --allow-read --allow-env services/fiat-cvm/probe.ts \
 *     --server <64-hex> --relay wss://relay.primal.net --tool cards
 *
 * Prints what the service actually answered. Read-only tools only by default;
 * `pay` requires --tool pay and an allowlisted key.
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { finalizeEvent, generateSecretKey, getPublicKey } from "npm:nostr-tools/pure";
import { nip44 } from "npm:nostr-tools";
import { Relay } from "npm:nostr-tools/relay";

const flags = parse(Deno.args, { string: ["server", "relay", "tool"], boolean: ["json"] });
if (!flags.server) {
  console.error("usage: probe.ts --server <64-hex> [--relay wss://...] [--tool cards|quote|status]");
  Deno.exit(2);
}
const relays = flags.relay ? [flags.relay] : ["wss://relay.primal.net", "wss://relay2.orangesync.tech"];
const server = flags.server;
const tool = flags.tool ?? "cards";

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const results: Record<string, unknown> = {};

async function send(relay: Relay, msg: unknown, label: string) {
  const inner = finalizeEvent({
    kind: 25910,
    tags: [["p", server]],
    content: JSON.stringify(msg),
    created_at: Math.floor(Date.now() / 1000),
  }, sk);
  const wrapSk = generateSecretKey();
  const conv = nip44.v2.utils.getConversationKey(wrapSk, server);
  const wrapped = finalizeEvent({
    kind: 1059,
    content: nip44.v2.encrypt(JSON.stringify(inner), conv),
    tags: [["p", server]],
    created_at: Math.floor(Date.now() / 1000),
  }, wrapSk);
  await relay.publish(wrapped);
  return label;
}

const r = await Relay.connect(relays[0], { enableReconnect: true, enablePing: true });
console.log(`[probe] client ${pk.slice(0, 12)}… → server ${server.slice(0, 12)}… via ${relays[0]}`);

await r.subscribe([{ kinds: [1059, 21059], "#p": [pk], limit: 0 }], {
  onevent: (event) => {
    try {
      const conv = nip44.v2.utils.getConversationKey(sk, event.pubkey);
      const plain = JSON.parse(nip44.v2.decrypt(event.content, conv));
      const msg = JSON.parse(plain.content);
      const text = msg?.result?.content?.[0]?.text;
      if (text) {
        try {
          results[String(msg.id)] = JSON.parse(text);
        } catch {
          // error text is not JSON — keep it verbatim so a failure is readable
          results[String(msg.id)] = { _raw: text, _isError: msg?.result?.isError ?? false };
        }
      } else {
        results[String(msg.id)] = msg.error ?? msg.result;
      }
    } catch (e) {
      console.log("[probe] could not read a reply:", (e as Error).message);
    }
  },
});

await send(r, { jsonrpc: "2.0", id: "1", method: "initialize" }, "initialize");
await new Promise((res) => setTimeout(res, 2500));
await send(r, { jsonrpc: "2.0", id: "2", method: "tools/list" }, "tools/list");
await new Promise((res) => setTimeout(res, 2500));
await send(r, { jsonrpc: "2.0", id: "3", method: "tools/call", params: { name: tool, arguments: tool === "quote" ? { amount: 10 } : (tool === "status" ? { card_id: "" } : {}) } }, "call");
// Must exceed the client's 20s request bound, or a timeout is indistinguishable
// from a hang — the exact confusion this probe exists to remove.
const waitMs = Number(Deno.env.get("PROBE_WAIT_MS") ?? 25000);
console.log(`\n(waiting up to ${waitMs}ms for the tool reply — the client bound is 20s)`);
await new Promise((res) => setTimeout(res, waitMs));

console.log("\n=== replies ===");
for (const [id, v] of Object.entries(results)) console.log(id, JSON.stringify(v).slice(0, 600));
if (Object.keys(results).length === 0) console.log("(no reply received)");

r.close();
Deno.exit(0);
