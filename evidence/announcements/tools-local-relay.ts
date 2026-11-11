/**
 * tools-local-relay.ts — a throwaway local relay that accepts every EVENT.
 *
 * Used only to prove that `emit-venue-announcement.ts` now EXITS after a real
 * publish (card t_7d410f66; `tools/nostr_publish_test.ts` is the unit-level
 * proof). The emit CLI is pointed at THIS relay, so nothing touches a real
 * relay and no dummy event lands on the network.
 *
 * usage: deno run --allow-net tools-local-relay.ts <port>
 */
const port = Number(Deno.args[0] ?? 0);

Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onmessage = (m) => {
    const d = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data));
    if (d[0] === "EVENT") {
      console.error(`local-relay: EVENT kind=${d[1]?.kind} id=${d[1]?.id?.slice(0, 16)} -> OK`);
      socket.send(JSON.stringify(["OK", d[1].id, true, "dummy-relay"]));
    }
  };
  return response;
});

console.error(`local-relay: listening on 127.0.0.1:${port}`);
