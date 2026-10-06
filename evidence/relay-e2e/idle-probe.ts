// idle-probe.ts — pin a relay's WebSocket connection lifetime.
//
// Opens ONE socket, subscribes, then does nothing. Records the wall-clock moment
// the socket closes. No publishes, no writes to the relay: this is a pure
// read-side measurement, so it cannot perturb the thing it measures.
//
//   deno run --allow-net --allow-write=probe-out-dir idle-probe.ts <wss-url> <out.txt> [minutes]
//
// Motivation: the Stage-1 venue server answers a request, then the reply is
// abandoned with "Tried to send message ... on a closed connection to
// wss://relay2.orangesync.tech/". Every CVM has the shape connect, subscribe,
// sit idle, answer. If a relay reaps idle subscribed sockets, that is the cause.

const url = Deno.args[0];
const outPath = Deno.args[1] ?? "idle-probe.txt";
const minutes = Number(Deno.args[2] ?? 45);

if (!url) {
  console.error("usage: idle-probe.ts <wss-url> <out.txt> [minutes]");
  Deno.exit(2);
}

const t0 = Date.now();
const lines: string[] = [];
const say = (m: string) => {
  const line = `${new Date().toISOString()} t+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`;
  lines.push(line);
  console.log(line);
  try {
    Deno.writeTextFileSync(outPath, lines.join("\n") + "\n");
  } catch (e) {
    console.error(`[probe] cannot write ${outPath}: ${(e as Error).message}`);
  }
};

say(`PROBE start url=${url} cap=${minutes}min`);
const ws = new WebSocket(url);
let events = 0;
let gotEose = false;

const done = (why: string, code?: number) => {
  say(`STOP ${why}${code !== undefined ? ` code=${code}` : ""} total_open=${
    ((Date.now() - t0) / 1000).toFixed(1)
  }s events=${events} eose=${gotEose}`);
  try {
    ws.close();
  } catch { /* ignore */ }
  Deno.exit(0);
};

ws.onopen = () => {
  say("OPEN socket established");
  // A single small REQ: a subscribed topology, exactly like a CVM in listen mode.
  ws.send(JSON.stringify(["REQ", "probe", { kinds: [1], limit: 1 }]));
  say("SENT REQ {kinds:[1],limit:1}");
};

ws.onmessage = (ev) => {
  const raw = String(ev.data);
  if (raw.startsWith('["EOSE"')) {
    gotEose = true;
    say("RECV EOSE (subscription live, now going idle)");
  } else if (raw.startsWith('["EVENT"')) {
    events++;
  } else {
    say(`RECV other: ${raw.slice(0, 80)}`);
  }
};

ws.onclose = (ev) => done("CLOSED by relay/transport", ev.code);
ws.onerror = () => say("ERROR event on socket");

// A heartbeat that does NOT touch the socket: it only proves the process is
// alive, so a silent hang can never be mistaken for "still connected".
const hb = setInterval(() => say(`heartbeat: still open (readyState=${ws.readyState})`), 60000);

// Hard cap so the probe always terminates and always leaves a written timeline.
setTimeout(() => {
  clearInterval(hb);
  done(`CAP reached (${minutes}min) - socket survived`);
}, minutes * 60 * 1000);
