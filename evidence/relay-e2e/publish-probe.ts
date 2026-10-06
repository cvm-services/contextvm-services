// publish-probe.ts — does PUBLISHING kill the relay2 socket?
//
// The idle probe shows a raw WebSocket to relay2 surviving 120s+ of idleness, so
// "the relay reaps idle sockets" does not explain the server's failure by itself.
// This probe reproduces the server's exact shape using the SAME library the server
// uses (npm:nostr-tools Relay): connect, subscribe, then publish a gift-wrap-sized
// kind-1059 event and watch whether the socket is still usable for the NEXT
// publish. It logs every relay response verbatim (OK true/false + message).
//
//   deno run --allow-net --allow-write=<dir> publish-probe.ts <wss-url> <out.txt>

import { finalizeEvent, generateSecretKey, getPublicKey } from "npm:nostr-tools";
import { Relay } from "npm:nostr-tools/relay";

const url = Deno.args[0];
const outPath = Deno.args[1] ?? "publish-probe.txt";
// Seconds of idleness BEFORE the first publish. The server's socket died after 28s
// idle; a 5s-idle publish succeeds. Sweeping this pins the threshold.
const idleBefore = Number(Deno.args[2] ?? 5);

const t0 = Date.now();
const lines: string[] = [];
const say = (m: string) => {
  const line = `${new Date().toISOString()} t+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`;
  lines.push(line);
  console.log(line);
  try {
    Deno.writeTextFileSync(outPath, lines.join("\n") + "\n");
  } catch { /* ignore */ }
};

const sk = generateSecretKey();
const pk = getPublicKey(sk);
say(`PROBE2 start url=${url} probe_pubkey=${pk.slice(0, 12)}`);

const relay = await Relay.connect(url);
say(`Relay.connect resolved; relay.connected=${relay.connected}`);

// The underlying socket is not part of nostr-tools' public API and its field name
// differs between versions, so find it, and if it is not exposed, infer liveness
// from the publish outcomes alone rather than failing the probe.
const handle = relay as unknown as Record<string, unknown>;
const ws = (handle.connection ?? handle.ws ?? handle._ws ?? handle.socket) as WebSocket | undefined;
const rs = () => (ws && typeof ws.readyState === "number" ? String(ws.readyState) : "n/a");
if (ws && typeof ws.addEventListener === "function") {
  ws.addEventListener("close", (e: Event) => say(`SOCKET CLOSE code=${(e as CloseEvent).code}`));
  ws.addEventListener("error", () => say("SOCKET ERROR event"));
  say("socket handle attached for close/error events");
} else {
  say(
    `socket handle not exposed (relay keys: ${Object.keys(handle).join(",")}); ` +
      "liveness inferred from publish outcomes",
  );
}

// Listen-mode subscription, exactly like a CVM waiting to be addressed.
relay.subscribe([{ kinds: [1059, 21059], "#p": [pk] }], {
  oneose: () => say("sub EOSE (listen mode live)"),
  onevent: () => say("sub EVENT"),
});
say("subscribed");

await new Promise((r) => setTimeout(r, idleBefore * 1000));
say(`after ${idleBefore}s idle: ws.readyState=${rs()} (local state only - a silently dropped peer still reads 1)`);

// A gift-wrap-sized, correctly signed kind-1059 event: the exact class of event
// the server publishes as its reply.
for (const attempt of [1, 2, 3]) {
  const content = "x".repeat(4000);
  const ev = finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", pk]],
    content,
  }, sk);
  say(`publish #${attempt} size=${JSON.stringify(ev).length}B ws.readyState=${rs()}`);
  try {
    const res = await relay.publish(ev);
    say(`publish #${attempt} RESOLVED: ${JSON.stringify(res)}`);
  } catch (e) {
    say(`publish #${attempt} THREW: ${(e as Error).message}`);
  }
  say(`after publish #${attempt}: ws.readyState=${rs()} relay.connected=${relay.connected}`);
  await new Promise((r) => setTimeout(r, 3000));
}

say("PROBE2 done (no close observed)");
try { relay.close(); } catch { /* ignore */ }
Deno.exit(0);
