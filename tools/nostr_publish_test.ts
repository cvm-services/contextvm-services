/**
 * nostr_publish_test.ts — the emitter's publish() must not hold the process open.
 *
 * SYMPTOM (2026-10-10, card t_7d410f66): `emit-venue-announcement.ts` published
 * to both relays, printed the accepted event AND its JSON, and then never
 * exited — `publish()` opened a WebSocket and resolved on the relay's OK without
 * ever closing it, so the Deno event loop kept running forever. A republish run
 * therefore had to be killed by hand, and the run that first hit this died on
 * the box (SIGTERM after ~28 min) with its evidence half written.
 *
 * `publish()` takes no socket handle, so this test observes the fix the way the
 * operator does: it stands up a local relay, publishes to it, and then requires
 * the connection to CLOSE. Before the fix the close never comes and the
 * assertion fails (RED). The relay is local, so this is an honest unit-level
 * proof of the lifecycle, not a claim about any real relay's behaviour.
 */

import { publish } from "./nostr.ts";

const NET_NOT_GRANTED =
  "\n[SKIP] needs --allow-net: publish()'s socket lifecycle is NOT verified here. " +
  "Run `deno task test:net` to verify it.\n";

async function netGranted(): Promise<boolean> {
  try {
    return (await Deno.permissions.query({ name: "net" })).state === "granted";
  } catch {
    return false;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

/** A one-shot local relay: accepts one EVENT, answers OK([]), reports the close. */
function startLocalRelay() {
  let resolveClosed: (v: string) => void;
  const closed = new Promise<string>((r) => (resolveClosed = r));
  let accepted = "";
  const ac = new AbortController();

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: () => {},
  }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (m) => {
      const data = JSON.parse(
        typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data),
      );
      if (data[0] === "EVENT") {
        accepted = data[1].id;
        socket.send(JSON.stringify(["OK", data[1].id, true, ""]));
      }
    };
    socket.onclose = () => resolveClosed("closed");
    return response;
  });

  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    closed: () => closed,
    accepted: () => accepted,
    stop: () => ac.abort(),
  };
}

Deno.test("publish() closes its socket after the relay's OK (so the CLI can exit)", async () => {
  if (!await netGranted()) {
    console.error(NET_NOT_GRANTED);
    return;
  }
  const relay = startLocalRelay();
  try {
    const event = { id: "a".repeat(64), kind: 11316, content: "{}", tags: [] };
    const res = await publish(relay.url, event);
    assert(res.accepted, `local relay should accept: ${res.msg}`);
    assert(relay.accepted() === event.id, `relay saw event ${relay.accepted()}`);

    const outcome = await Promise.race([
      relay.closed(),
      new Promise<string>((r) =>
        setTimeout(() => r("TIMEOUT: socket still open 5s after OK"), 5000)
      ),
    ]);
    assert(outcome === "closed", `publish() left the socket open - ${outcome}`);
  } finally {
    relay.stop();
  }
});
