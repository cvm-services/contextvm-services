// Venue CVM server tests -- Stage 1.
//
// These tests exercise the server's tool logic directly (no relay required),
// so `deno task test` runs with `--allow-read` only.

import {
  buildIndex,
  handleMcpMessage,
  handleToolCall,
  loadVenues,
  type McpRequest,
  type VenueIndex,
  parseRelayList,
  parseVenueFilter,
  frameBytes,
  publishToRelays,
  RELAY_FRAME_CAP_BYTES,
  RELAY_OPTIONS,

  requestFilter,

  eventBytes,
  RELAY_EVENT_CAP_BYTES,
} from "./server.ts";
import { Relay } from "npm:nostr-tools";
import { venueToAnnouncement } from "../../tools/venue_to_announcement.ts";

let index: VenueIndex;

async function setup() {
  index = await buildIndex();
}

// ---------------------------------------------------------------------------
// Relay configuration. A server that cannot be told which relays to listen on
// can only ever sit on the hard-coded default set — which is NOT where these
// venues' announcements live (relay2.orangesync.tech + primal). Criterion 7 is
// about reachability over a REAL relay; the relay set must be injectable.
// ---------------------------------------------------------------------------

Deno.test("RED: VENUE_SERVER_RELAYS overrides the default relay set", () => {
  // absent -> fallback
  const fallback = ["wss://a.example", "wss://b.example"];
  if (JSON.stringify(parseRelayList(undefined, fallback)) !== JSON.stringify(fallback)) {
    throw new Error("absent env must fall back to the default set");
  }
  // a real list
  const got = parseRelayList(
    "wss://relay2.orangesync.tech, wss://relay.primal.net",
    fallback,
  );
  if (JSON.stringify(got) !== JSON.stringify(["wss://relay2.orangesync.tech", "wss://relay.primal.net"])) {
    throw new Error(`relay list not honoured: ${JSON.stringify(got)}`);
  }
  // whitespace/garbage -> fallback, never an empty listen set
  if (JSON.stringify(parseRelayList("  , ,", fallback)) !== JSON.stringify(fallback)) {
    throw new Error("an effectively-empty list must fall back, not listen nowhere");
  }
});

Deno.test("RED: tools/list exposes menu and order with real schemas", async () => {
  await setup();
  const res = await handleMcpMessage(index, { method: "tools/list", id: 1 });
  if (!res || "error" in res) throw new Error("tools/list failed");
  const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
  const names = tools.map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["menu", "order"])) {
    throw new Error(`expected [menu, order], got ${JSON.stringify(names)}`);
  }

  const orderTool = tools.find((t) => t.name === "order");
  if (!orderTool) throw new Error("order tool missing");
  const schema = orderTool.inputSchema as Record<string, unknown>;
  if (!schema.properties || typeof schema.properties !== "object") {
    throw new Error("order inputSchema has no properties");
  }
  const props = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!props.items) throw new Error("order.items missing from inputSchema");
  if (!props.fulfilment) throw new Error("order.fulfilment missing from inputSchema");
  if (!props.when) throw new Error("order.when missing from inputSchema");
  if (!props.ship) {
    throw new Error("ship missing from inputSchema (used conditionally for delivery)");
  }
  if (!required.includes("venue_slug")) throw new Error("order.venue_slug is not required");
  if (!required.includes("items")) throw new Error("order.items is not required");
  if (!required.includes("fulfilment")) throw new Error("order.fulfilment is not required");
  if (!required.includes("when")) throw new Error("order.when is not required");

  const desc = String(orderTool.description ?? "");
  if (/order placed/i.test(desc)) {
    throw new Error("order tool description must not claim the order is placed");
  }
  if (!/venue['']?s own/i.test(desc) && !/venue page/i.test(desc)) {
    throw new Error("order tool description must mention checkout on the venue's own page");
  }
});

Deno.test("RED: menu returns 188 items with sku, name, prices, available, allergens", async () => {
  await setup();
  const res = handleToolCall(index, "menu", {});
  const text = res.content[0].text;
  const payload = JSON.parse(text);
  if (payload.total_items !== 188) {
    throw new Error(`expected 188 items, got ${payload.total_items}`);
  }
  const items = payload.venues.flatMap((v: { items: Array<Record<string, unknown>> }) => v.items);
  if (items.length !== 188) {
    throw new Error(`flat item count ${items.length} != 188`);
  }
  for (const it of items) {
    if (!it.sku) throw new Error("item missing sku");
    if (!it.name) throw new Error("item missing name");
    if (!it.prices_by_order_method || typeof it.prices_by_order_method !== "object") {
      throw new Error(`item ${it.sku} missing prices_by_order_method`);
    }
    if (typeof it.available !== "boolean") throw new Error(`item ${it.sku} missing available`);
    if (!("allergens" in it)) throw new Error(`item ${it.sku} missing allergens field`);
  }
});

Deno.test("RED: a known sku price matches venue.json exactly", async () => {
  await setup();
  const res = handleToolCall(index, "menu", {});
  const payload = JSON.parse(res.content[0].text);
  const items = payload.venues.flatMap((v: { items: Array<Record<string, unknown>> }) => v.items);
  const cheeseburger = items.find((it: { sku: string }) => it.sku === "331227");
  if (!cheeseburger) throw new Error("Cheeseburger sku 331227 not found");
  const prices = cheeseburger.prices_by_order_method as Record<string, number>;
  if (prices.pickup !== 8.9) {
    throw new Error(`Cheeseburger pickup price expected 8.9, got ${prices.pickup}`);
  }
  if (prices.delivery !== 9.5) {
    throw new Error(`Cheeseburger delivery price expected 9.5, got ${prices.delivery}`);
  }
});

Deno.test("RED: order with an unknown sku fails loud", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "doppelt-kaese-berlin",
    items: [{ sku: "DOES-NOT-EXIST", qty: 1 }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (!res.isError) {
    throw new Error("expected error for unknown sku, got success");
  }
  const payload = JSON.parse(res.content[0].text);
  if (!/unknown sku/i.test(payload.error)) {
    throw new Error(`expected 'unknown sku' error, got ${payload.error}`);
  }
});

Deno.test("RED: delivery requires ship.address; pickup and dine_in do not", async () => {
  await setup();

  const baseOrder = {
    venue_slug: "doppelt-kaese-berlin",
    items: [{ sku: "331227", qty: 1, options: { "68405": ["366859"] } }],
    when: "asap",
  };

  // pickup: no address needed
  const pickup = handleToolCall(index, "order", { ...baseOrder, fulfilment: "pickup" });
  if (pickup.isError) {
    throw new Error(`pickup without address should succeed: ${pickup.content[0].text}`);
  }

  // dine_in: no address needed
  const dineIn = handleToolCall(index, "order", { ...baseOrder, fulfilment: "dine_in" });
  if (dineIn.isError) {
    throw new Error(`dine_in without address should succeed: ${dineIn.content[0].text}`);
  }

  // delivery: address required
  const deliveryNoAddr = handleToolCall(index, "order", { ...baseOrder, fulfilment: "delivery" });
  if (!deliveryNoAddr.isError) {
    throw new Error("delivery without ship.address should fail");
  }
  const err = JSON.parse(deliveryNoAddr.content[0].text).error;
  if (!/ship\.address/i.test(err)) {
    throw new Error(`expected ship.address error, got ${err}`);
  }

  // delivery: with address succeeds
  const deliveryWithAddr = handleToolCall(index, "order", {
    ...baseOrder,
    fulfilment: "delivery",
    ship: {
      address: {
        street: "Teststr. 1",
        city: "Berlin",
        postal_code: "10115",
        country: "DE",
      },
    },
  });
  if (deliveryWithAddr.isError) {
    throw new Error(`delivery with address should succeed: ${deliveryWithAddr.content[0].text}`);
  }
});

Deno.test("RED: order returns basket + rail + deep-link, not 'order placed'", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "doppelt-kaese-berlin",
    items: [
      { sku: "331227", qty: 2, options: { "68405": ["366859"] } },
      { sku: "331233", qty: 1 },
    ],
    fulfilment: "pickup",
    when: "asap",
    notes: "No onions please",
  });
  if (res.isError) throw new Error(`order should succeed: ${res.content[0].text}`);

  const payload = JSON.parse(res.content[0].text);
  if (payload.status !== "basket") {
    throw new Error(`expected status 'basket', got ${payload.status}`);
  }
  if (!payload.venue || !payload.venue.deep_link) {
    throw new Error("order response missing venue.deep_link");
  }
  const text = JSON.stringify(payload);
  if (/order placed/i.test(text)) {
    throw new Error("response must not read as 'order placed'");
  }
  if (
    !/venue['']?s own page/i.test(payload.note ?? "") && !/venue page/i.test(payload.note ?? "")
  ) {
    throw new Error("response note must say checkout is on the venue's own page");
  }
  if (!Array.isArray(payload.lines) || payload.lines.length !== 2) {
    throw new Error("expected 2 basket lines");
  }
  if (typeof payload.total !== "number") {
    throw new Error("expected numeric total");
  }
  // Cheeseburger qty 2 at pickup 8.9 = 17.8; Curly Fries qty 1 at pickup 4.5
  const expected = Math.round((8.9 * 2 + 4.5) * 100) / 100;
  if (payload.total !== expected) {
    throw new Error(`total expected ${expected}, got ${payload.total}`);
  }
});

Deno.test("loadVenues loads two venues with 188 total items", async () => {
  const venues = await loadVenues();
  if (venues.length !== 2) throw new Error(`expected 2 venues, got ${venues.length}`);
  let count = 0;
  for (const v of venues) {
    count += v.items.length;
  }
  if (count !== 188) throw new Error(`expected 188 items, got ${count}`);
});

Deno.test("tools/call returns unknown-tool error", async () => {
  await setup();
  const res = await handleMcpMessage(index, {
    method: "tools/call",
    id: 2,
    params: { name: "nope" },
  });
  if (!res || "error" in res) throw new Error("tools/call envelope should succeed");
  const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
  if (!result.isError) throw new Error("unknown tool should return isError");
});

Deno.test("initialize returns serverInfo", async () => {
  await setup();
  const res = await handleMcpMessage(index, { method: "initialize", id: 0 });
  if (!res || "error" in res) throw new Error("initialize failed");
  const info = (res.result as { serverInfo: { name: string } }).serverInfo;
  if (!info.name.includes("venue")) throw new Error(`unexpected server name ${info.name}`);
});

Deno.test("order fails loud for sku not in chosen venue", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "doppelt-kaese-berlin",
    items: [
      { sku: "1", qty: 1 }, // pizza sku used with doppelt venue
    ],
    fulfilment: "pickup",
    when: "asap",
  });
  if (!res.isError) throw new Error("expected error for foreign sku");
  const payload = JSON.parse(res.content[0].text);
  if (!/unknown sku/i.test(payload.error)) {
    throw new Error(`expected unknown sku error, got ${payload.error}`);
  }
});

Deno.test("menu filter by venue_slug returns only that venue", async () => {
  await setup();
  const res = handleToolCall(index, "menu", { venue_slug: "doppelt-kaese-berlin" });
  if (res.isError) throw new Error(res.content[0].text);
  const payload = JSON.parse(res.content[0].text);
  if (payload.venues.length !== 1) throw new Error("expected one venue");
  if (payload.venues[0].venue_slug !== "doppelt-kaese-berlin") {
    throw new Error("wrong venue slug");
  }
  if (payload.total_items !== 76) {
    throw new Error(`expected 76 doppelt items, got ${payload.total_items}`);
  }
});

// ---------------------------------------------------------------------------
// Ambiguous skus. Pizza lists three skus whose items are DISTINCT products, and
// sku 36's two items have different prices (Bionade 3.60 / Vitamalz 2.70). A
// basket that resolves "36" to whichever came first quotes one product's price
// for the other, so the sku must be refused and the venue item id offered.
// ---------------------------------------------------------------------------

Deno.test("RED: an ambiguous sku fails loud and names the colliding item ids", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ sku: "36", qty: 1 }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (!res.isError) {
    throw new Error("ambiguous sku 36 must fail loud, not resolve to a product");
  }
  const err = JSON.parse(res.content[0].text).error as string;
  if (!/ambiguous sku: 36/.test(err)) {
    throw new Error(`expected 'ambiguous sku: 36', got ${err}`);
  }
  if (!/6943935/.test(err) || !/6943943/.test(err)) {
    throw new Error(`error must name both colliding ids, got ${err}`);
  }
  if (!/Bionade/.test(err) || !/Vitamalz/.test(err)) {
    throw new Error(`error must name both products, got ${err}`);
  }
});

Deno.test("RED: an ambiguous item is orderable by its venue item id", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ id: "6943943", qty: 1 }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(`ordering by id should succeed: ${res.content[0].text}`);
  const payload = JSON.parse(res.content[0].text);
  const line = payload.lines[0];
  if (line.id !== "6943943") {
    throw new Error(`expected line id 6943943, got ${line.id}`);
  }
  if (!/Vitamalz/.test(line.name)) {
    throw new Error(`expected Vitamalz (id 6943943), got ${line.name}`);
  }
  if (line.unit_price !== 2.7) {
    throw new Error(`expected the 2.70 Vitamalz price, got ${line.unit_price}`);
  }
});

Deno.test("RED: menu exposes the venue item id, so an ambiguous sku is resolvable", async () => {
  await setup();
  const res = handleToolCall(index, "menu", { venue_slug: "pizza-e-pasta-ruedesheimerplatz" });
  const payload = JSON.parse(res.content[0].text);
  const items = payload.venues[0].items as Array<Record<string, unknown>>;
  const missing = items.filter((it) => typeof it.id !== "string" || !it.id);
  if (missing.length > 0) {
    throw new Error(`${missing.length} menu items expose no id — a colliding sku is then unusable`);
  }
  const thirtySix = items.filter((it) => it.sku === "36");
  if (thirtySix.length !== 2) {
    throw new Error(`expected 2 items at sku 36, got ${thirtySix.length}`);
  }
  if (new Set(thirtySix.map((it) => it.id)).size !== 2) {
    throw new Error("sku 36 must expose two DISTINCT ids, otherwise it cannot be disambiguated");
  }
});

Deno.test("RED: an item naming both sku and id, or neither, fails loud", async () => {
  await setup();
  const base = { venue_slug: "doppelt-kaese-berlin", fulfilment: "pickup", when: "asap" };
  const both = handleToolCall(index, "order", {
    ...base,
    items: [{ sku: "331227", id: "1", qty: 1 }],
  });
  if (!both.isError) throw new Error("naming both sku and id must fail");
  const neither = handleToolCall(index, "order", { ...base, items: [{ qty: 1 }] });
  if (!neither.isError) throw new Error("an item with neither sku nor id must fail");
  const badId = handleToolCall(index, "order", { ...base, items: [{ id: "NOPE", qty: 1 }] });
  if (!badId.isError) throw new Error("an unknown item id must fail");
  if (!/unknown item id/i.test(JSON.parse(badId.content[0].text).error)) {
    throw new Error("an unknown item id must say so");
  }
});

Deno.test("RED: pizza is priced only for pickup, and a delivery line says so", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ id: "6943943", qty: 2 }],
    fulfilment: "delivery",
    when: "asap",
    ship: { address: { street: "Teststr. 1", city: "Berlin", postal_code: "10115", country: "DE" } },
  });
  if (res.isError) throw new Error(`pizza delivery basket should build: ${res.content[0].text}`);
  const line = JSON.parse(res.content[0].text).lines[0];
  if (typeof line.unit_price !== "number" || line.unit_price <= 0) {
    throw new Error(`a pizza line must never be free/absent, got ${line.unit_price}`);
  }
  if (line.method_used !== "pickup") {
    throw new Error(`expected the pickup price to be reused, got ${line.method_used}`);
  }
  if (!line.price_note || !/delivery price not published/.test(line.price_note)) {
    throw new Error(
      `a delivery line priced from pickup must carry the note, got ${line.price_note}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-venue identity (Stage 1b). Each venue is announced under its OWN pubkey,
// so a single process that answers for both venues makes discovery a dead end
// for the venue whose key is NOT the one the process runs under. The fix is one
// server instance per announced identity: VENUE_SERVER_VENUES scopes an instance
// to a subset of venues. Absent/empty => all venues (unchanged default).
// ---------------------------------------------------------------------------

Deno.test("RED: parseVenueFilter maps absent/empty to null, and splits a list", () => {
  if (parseVenueFilter(undefined) !== null) {
    throw new Error("absent env must mean 'all venues' (null)");
  }
  if (parseVenueFilter("") !== null) {
    throw new Error("empty env must mean 'all venues' (null)");
  }
  if (parseVenueFilter("  ,  ") !== null) {
    throw new Error("whitespace-only env must mean 'all venues' (null)");
  }
  const got = parseVenueFilter("pizza-e-pasta-ruedesheimerplatz, doppelt-kaese-berlin");
  if (JSON.stringify(got) !== JSON.stringify(["pizza-e-pasta-ruedesheimerplatz", "doppelt-kaese-berlin"])) {
    throw new Error(`filter not split/trimmed: ${JSON.stringify(got)}`);
  }
});

Deno.test("RED: a venue-filtered instance serves ONLY that venue's menu", async () => {
  const filtered = await buildIndex(["pizza-e-pasta-ruedesheimerplatz"]);
  const res = handleToolCall(filtered, "menu", {});
  if (res.isError) throw new Error(res.content[0].text);
  const payload = JSON.parse(res.content[0].text);
  const slugs = payload.venues.map((v: { venue_slug: string }) => v.venue_slug);
  if (JSON.stringify(slugs) !== JSON.stringify(["pizza-e-pasta-ruedesheimerplatz"])) {
    throw new Error(`expected only pizza, got ${JSON.stringify(slugs)}`);
  }
  if (payload.total_items !== 112) {
    throw new Error(`expected 112 pizza items, got ${payload.total_items}`);
  }
});

Deno.test("RED: a venue-filtered instance refuses an order for a venue it does not serve", async () => {
  const filtered = await buildIndex(["pizza-e-pasta-ruedesheimerplatz"]);
  const res = handleToolCall(filtered, "order", {
    venue_slug: "doppelt-kaese-berlin",
    items: [{ sku: "331227", qty: 1 }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (!res.isError) {
    throw new Error("an order for a venue this instance does not serve must fail loud");
  }
  const err = JSON.parse(res.content[0].text).error as string;
  if (!/unknown venue_slug: doppelt-kaese-berlin/.test(err)) {
    throw new Error(`error must name the unknown venue, got ${err}`);
  }
});

Deno.test("RED: a venue-filtered instance still orders its own venue normally", async () => {
  const filtered = await buildIndex(["pizza-e-pasta-ruedesheimerplatz"]);
  const res = handleToolCall(filtered, "order", {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ id: "6943943", qty: 1 }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(`own venue order should succeed: ${res.content[0].text}`);
  const payload = JSON.parse(res.content[0].text);
  if (payload.status !== "basket") throw new Error("expected basket status");
  if (payload.venue.slug !== "pizza-e-pasta-ruedesheimerplatz") {
    throw new Error(`expected pizza venue in response, got ${payload.venue.slug}`);
  }
});

// ---------------------------------------------------------------------------
// Relay publishing must be INDEPENDENT per relay and BOUNDED in time.
//
// Production, 2026-10-06: sendResponse() published with a sequential
// `for (...) await relay.publish(...)`. A relay that is CONNECTED but SILENT
// (open socket, never answers with an OK) therefore parked the loop, and every
// relay after it in the list delivered nothing -- the client timed out even
// though a healthy relay was in the set. That is why both-relay runs failed on
// different checks each time, why restarting the server did not cure it, and
// why a green primal-only run proved nothing about the relay set. See
// evidence/relay-e2e/FINDING-2-sequential-publish-suppresses-every-reply.md.
// ---------------------------------------------------------------------------

type FakeTarget = { publish: (e: unknown) => Promise<string> };
const FAKE_EVENT = { id: "e".repeat(64) };

function silentTarget(counter: { calls: number }): FakeTarget {
  return {
    publish: () => {
      counter.calls++;
      return new Promise<string>(() => {}); // connected, never answers
    },
  };
}

Deno.test("RED: a silent relay does not withhold the reply from a healthy relay", async () => {
  const got: unknown[] = [];
  const counter = { calls: 0 };
  const healthy: FakeTarget = {
    publish: (e) => {
      got.push(e);
      return Promise.resolve("");
    },
  };

  const started = Date.now();
  const res = await publishToRelays([silentTarget(counter), healthy], FAKE_EVENT, {
    timeoutMs: 400,
  });
  const elapsed = Date.now() - started;

  if (got.length !== 1) throw new Error(`healthy relay must receive the reply; got ${got.length}`);
  if (counter.calls !== 1) throw new Error(`silent relay must be attempted once; got ${counter.calls}`);
  if (res.delivered !== 1 || res.failed !== 1) {
    throw new Error(`expected 1 delivered/1 failed; got ${JSON.stringify(res)}`);
  }
  if (elapsed > 3000) throw new Error(`deadline must bound the stall; took ${elapsed}ms`);
});

Deno.test("RED: relay order does not change the outcome (silent relay last)", async () => {
  const got: unknown[] = [];
  const counter = { calls: 0 };
  const healthy: FakeTarget = {
    publish: (e) => {
      got.push(e);
      return Promise.resolve("");
    },
  };
  const res = await publishToRelays([healthy, silentTarget(counter)], FAKE_EVENT, {
    timeoutMs: 400,
  });
  if (got.length !== 1) throw new Error(`healthy relay must receive the reply; got ${got.length}`);
  if (res.delivered !== 1 || res.failed !== 1) {
    throw new Error(`expected 1 delivered/1 failed; got ${JSON.stringify(res)}`);
  }
});

Deno.test("RED: a relay that refuses the event is counted failed, others still deliver", async () => {
  const got: unknown[] = [];
  const healthy: FakeTarget = {
    publish: (e) => {
      got.push(e);
      return Promise.resolve("");
    },
  };
  const refusing: FakeTarget = { publish: () => Promise.reject(new Error("blocked: not allowed")) };
  const res = await publishToRelays([refusing, healthy], FAKE_EVENT, { timeoutMs: 400 });
  if (got.length !== 1) throw new Error("healthy relay must still receive the reply");
  if (res.delivered !== 1 || res.failed !== 1) {
    throw new Error(`expected 1 delivered/1 failed; got ${JSON.stringify(res)}`);
  }
});

Deno.test("RED: all healthy relays deliver, none are counted failed", async () => {
  const got: unknown[] = [];
  const mk = (): FakeTarget => ({
    publish: (e) => {
      got.push(e);
      return Promise.resolve("");
    },
  });
  const res = await publishToRelays([mk(), mk(), mk()], FAKE_EVENT, { timeoutMs: 400 });
  if (got.length !== 3) throw new Error(`all three relays must receive the reply; got ${got.length}`);
  if (res.delivered !== 3 || res.failed !== 0) {
    throw new Error(`expected 3 delivered/0 failed; got ${JSON.stringify(res)}`);
  }
});

// ---------------------------------------------------------------------------
// A dropped relay must come BACK, and a half-dead socket must be noticed.
//
// Production, 2026-10-06: relay2 closes the socket mid-run ("Tried to send
// message ... on a closed connection to wss://relay2.orangesync.tech/") and the
// server never set nostr-tools' enableReconnect, so AbstractRelay.handleHardClose
// took the ELSE branch -- onclose + closeAllSubscriptions -- and that Relay
// object stayed dead for the whole process lifetime. A client reading only from
// relay2 stopped being served at the moment of the close: the 2/4 e2e shape.
//
// nostr-tools ALREADY implements reconnect-with-backoff and re-fires every open
// subscription in ws.onopen; both are off unless asked for. Enabling them is the
// fix -- not a hand-rolled supervisor, which would duplicate tested library code.
// The test below is a REGRESSION GUARD over a constant, not a behaviour proof: it
// can only fail if the flag is hand-edited back to false. The behavioural proof that
// a dropped socket is actually reconnected AND re-subscribed is the net test further
// down (it fails with reconnect off). Deleting the flags silently restores the outage,
// which is exactly what this guard is for.
// ---------------------------------------------------------------------------

Deno.test("GUARD (constant): reconnect and ping stay enabled", () => {
  if (RELAY_OPTIONS.enableReconnect !== true) {
    throw new Error(
      "enableReconnect must be true -- nostr-tools defaults it OFF, and with it off a dropped relay is dead for the life of the process",
    );
  }
  if (RELAY_OPTIONS.enablePing !== true) {
    throw new Error(
      "enablePing must be true -- without it a socket that is open but never answers is never detected",
    );
  }
});

const canNet = (await Deno.permissions.query({ name: "net" })).state === "granted";

Deno.test({
  name: "RED: a relay whose socket closes is reconnected AND re-subscribed (net)",
  ignore: !canNet,
  fn: async () => {
    let connections = 0;
    let reqs = 0;
    const ac = new AbortController();
    const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, (req) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("no upgrade", { status: 400 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        connections++;
        // drop every socket shortly after it opens, so a successful test can
        // only pass by reconnecting
        setTimeout(() => {
          try {
            socket.close();
          } catch (_) {
            // already closed
          }
        }, 200);
      };
      socket.onmessage = (ev) => {
        if (String(ev.data).startsWith('["REQ"')) reqs++;
      };
      return response;
    });
    const url = `ws://localhost:${(server.addr as Deno.NetAddr).port}`;

    try {
      const relay = await Relay.connect(url, { ...RELAY_OPTIONS });
      // the real backoff starts at 10s; keep the test fast but exercise the
      // library's own reconnect path
      relay.resubscribeBackoff = [50, 50, 50, 50];
      relay.subscribe([{ kinds: [1059], limit: 0 }], { onevent: () => {} });

      await new Promise((r) => setTimeout(r, 2000));
      relay.close();

      if (connections < 2) {
        throw new Error(`a dropped relay must be reconnected; connections=${connections}`);
      }
      if (reqs < 2) {
        throw new Error(`a reconnected relay must be re-subscribed; REQs=${reqs}`);
      }
    } finally {
      ac.abort();
    }
  },
});

// ---------------------------------------------------------------------------
// An undeliverable reply must be LOUD, not silent.
//
// FINDING-3: the all-venues menu gift wrap measures 131595 B, over strfry's
// default maxWebsocketPayloadSize (131072). relay2 rejects that frame outright
// -- "131595 > 131072" is in its own log -- and from our side the client just
// timed out, with nothing in our logs to say why. Relays differ (primal accepted
// the same frame), so we still attempt the publish everywhere; we simply refuse
// to do it silently.
// ---------------------------------------------------------------------------

Deno.test("RED: an oversized reply frame is called out locally", async () => {
  const logs: string[] = [];
  const delivered: unknown[] = [];
  const target = {
    publish: (e: unknown) => {
      delivered.push(e);
      return Promise.resolve("");
    },
  };
  const big = { id: "0".repeat(64), content: "a".repeat(RELAY_FRAME_CAP_BYTES) };

  if (frameBytes(big) <= RELAY_FRAME_CAP_BYTES) {
    throw new Error("test premise: this event must exceed the frame cap");
  }
  await publishToRelays([target], big, { log: (m) => logs.push(m) });

  if (delivered.length !== 1) {
    throw new Error("relays differ: an oversized frame must still be attempted, not withheld");
  }
  if (!logs.some((l) => l.includes("WARNING") && l.toLowerCase().includes("frame"))) {
    throw new Error(`an oversized frame must raise a local warning; logs=${JSON.stringify(logs)}`);
  }
});

Deno.test("RED: a reply that fits logs no size warning", async () => {
  const logs: string[] = [];
  const target = { publish: () => Promise.resolve("") };
  await publishToRelays([target], { id: "0".repeat(64), content: "ok" }, {
    log: (m) => logs.push(m),
  });
  if (logs.some((l) => l.toLowerCase().includes("frame"))) {
    throw new Error(`a normal reply must not warn; logs=${JSON.stringify(logs)}`);
  }
});

// ---------------------------------------------------------------------------
// The request filter must be ADDRESSED, not a firehose.
//
// FINDING-3's corollary: we subscribed to { kinds: [1059, 21059], limit: 0 } --
// every gift wrap on the relay -- and filtered by recipient in the handler. The
// relay-side filter `#p` is exact (a CVM request names the server's key in its
// `p` tag), and the whole-relay firehose is what drove relay2's reader stalls
// (2635 x `1006/Resource temporarily unavailable` in 90 min).
// ---------------------------------------------------------------------------

Deno.test("RED: the subscription filter is addressed to the server key", () => {
  const serverPk = "a1".repeat(32);
  const filter = requestFilter(serverPk);

  if (!filter.kinds.includes(1059) || !filter.kinds.includes(21059)) {
    throw new Error(`both CVM request kinds must be requested; kinds=${filter.kinds}`);
  }
  const p = filter["#p"];
  if (!Array.isArray(p) || p.length !== 1 || p[0] !== serverPk) {
    throw new Error(
      `filter must be addressed to exactly the server key, got ${JSON.stringify(p)}`,
    );
  }
});

Deno.test("GUARD (constant): the subscription stays addressed, not a firehose", () => {
  const filter = requestFilter("b2".repeat(32));
  // REGRESSION GUARD over the filter's shape, not a behaviour proof: `requestFilter`
  // hardcodes `#p`, so this can only fail if that is removed. Its value is that a
  // firehose filter has no `#p` at all, which is the regression it pins.
  if (!("#p" in filter)) {
    throw new Error("a filter without #p is the whole-relay firehose, not an addressed subscription");
  }
});

// ---------------------------------------------------------------------------
// TWO caps, not one. A relay can accept the WebSocket frame and still refuse the
// EVENT inside it.
//
// Measured 2026-10-06 on relay2 (strfry 1.1.0): our per-venue menu wraps are
// 66055 B (doppelt) / 76975 B (pizza) -- UNDER the 131072 frame cap -- and were
// still refused:
//   publish warning: invalid: event too large: 66045
//   publish warning: invalid: event too large: 76965
// 65536 is strfry's DEFAULT maxEventSize (64 KiB). So a frame-cap warning alone
// tells an operator the frame is fine right up until the relay refuses the
// event, which is exactly the silent-ish failure this path exists to prevent.
// Requested by the operator's own deployment: one instance per announced venue
// produces ~66-77 KB wraps, i.e. just over the event default.
// ---------------------------------------------------------------------------

Deno.test("RED: an event over strfry's default maxEventSize is called out", async () => {
  const logs: string[] = [];
  const delivered: unknown[] = [];
  const target = {
    publish: (e: unknown) => {
      delivered.push(e);
      return Promise.resolve("");
    },
  };
  // Over the 65536 event cap, comfortably under the 131072 frame cap: this must
  // trip the EVENT warning only.
  const ev = { id: "0".repeat(64), content: "a".repeat(66000) };

  if (eventBytes(ev) <= RELAY_EVENT_CAP_BYTES) {
    throw new Error("test premise: this event must exceed the event cap");
  }
  if (frameBytes(ev) > RELAY_FRAME_CAP_BYTES) {
    throw new Error("test premise: this event must stay under the frame cap");
  }

  await publishToRelays([target], ev, { log: (m) => logs.push(m) });

  if (delivered.length !== 1) {
    throw new Error("relays differ: an over-cap event must still be attempted everywhere");
  }
  if (!logs.some((l) => l.includes("65536") && l.toLowerCase().includes("event"))) {
    throw new Error(
      `an over-event-cap reply must name the 65536 event cap; logs=${JSON.stringify(logs)}`,
    );
  }
  if (logs.some((l) => l.toLowerCase().includes("frame is"))) {
    throw new Error("this reply fits the frame cap, so no frame warning should fire");
  }
});

Deno.test("RED: a reply under both caps logs neither warning", async () => {
  const logs: string[] = [];
  const target = { publish: () => Promise.resolve("") };
  await publishToRelays([target], { id: "0".repeat(64), content: "ok" }, {
    log: (m) => logs.push(m),
  });
  if (logs.some((l) => l.includes("65536") || l.toLowerCase().includes("frame is"))) {
    throw new Error(`a small reply must not warn; logs=${JSON.stringify(logs)}`);
  }
});

/**
 * JSON object key order carries no meaning in a JSON Schema, so the comparison below
 * sorts keys before stringifying. Verified 2026-10-06: the only difference between the
 * announced and the served schema was that the server's literal happens to list
 * `venue_slug` last. A textual comparison called that drift and would have sent someone
 * hunting a semantic mismatch that did not exist.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" +
      Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") +
      "}";
  }
  return JSON.stringify(value);
}

// The announcement and the server each describe the `order` tool's arguments. If they
// disagree, a client is handed an interface the server does not accept. Measured
// 2026-10-06: the published schema still required `{sku, qty}` and had no `id` while the
// server had started refusing colliding skus in favour of the venue item id — so the
// published interface hid the only way to order pizza's sku 36/110/44 at all.
Deno.test("RED: the announced order schema matches the schema the server answers with", async () => {
  await setup();
  const res = await handleMcpMessage(index, { method: "tools/list", id: 9 });
  if (!res || "error" in res) throw new Error("tools/list failed");
  const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
  const served = tools.find((t) => t.name === "order")?.inputSchema;
  if (!served) throw new Error("the server advertises no order schema");

  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("../../venues/doppelt-kaese-berlin/venue.json", import.meta.url),
    ),
  );
  const announcedContent = venueToAnnouncement(raw).content as {
    tools: Array<{ name: string; inputSchema: unknown }>;
  };
  const announced = announcedContent.tools.find((t) => t.name === "order")?.inputSchema;
  if (!announced) throw new Error("the announcement carries no order schema");

  if (canonical(served) !== canonical(announced)) {
    throw new Error(
      "the announced order schema differs from the served one: a client would read an interface the server does not accept",
    );
  }

  const items = (served as {
    properties: {
      items: { items: { properties: Record<string, unknown>; required: string[] } };
    };
  }).properties.items.items;
  if (!items.properties.id) {
    throw new Error("the published schema hides `id`, so a colliding sku cannot be ordered");
  }
  if (items.required.includes("sku")) {
    throw new Error("items must not require a sku now that an id is accepted");
  }
  if (!items.required.includes("qty")) {
    throw new Error("items must still require a qty");
  }
});

// The comparison above holds the two schemas to EACH OTHER, so both sides could move
// together to a bare `{type: "object"}` and still pass while telling a client nothing
// about what `options` accepts. PLAN-0006 Track D AC6 asks for `order.items[].options`
// to be documented and for the drift test to cover options, so this asserts the SHAPE
// itself, on both sides, and then that the declared shape is the one the server
// accepts — a schema a client obeys and the server refuses is the drift that matters.
Deno.test("RED: both order schemas declare items[].options as group id -> array of choice ids, and the server accepts it", async () => {
  await setup();
  const listed = await handleMcpMessage(index, { method: "tools/list", id: 11 });
  if (!listed || "error" in listed) throw new Error("tools/list failed");
  const served = (listed.result as { tools: Array<Record<string, unknown>> }).tools
    .find((t) => t.name === "order")?.inputSchema;

  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("../../venues/doppelt-kaese-berlin/venue.json", import.meta.url),
    ),
  );
  const announcedContent = venueToAnnouncement(raw).content as {
    tools: Array<{ name: string; inputSchema: unknown }>;
  };
  const announced = announcedContent.tools.find((t) => t.name === "order")?.inputSchema;

  for (const [side, schema] of [["served", served], ["announced", announced]] as const) {
    if (!schema) throw new Error(`${side} order schema is missing`);
    const options = ((schema as unknown) as {
      properties: {
        items: { items: { properties: Record<string, Record<string, unknown>> } };
      };
    }).properties.items.items.properties.options;
    if (!options) throw new Error(`${side} order schema declares no items[].options`);
    if (options.type !== "object") {
      throw new Error(`${side} declares options as ${String(options.type)}, not an object`);
    }
    const value = options.additionalProperties as Record<string, unknown> | undefined;
    if (!value || value.type !== "array") {
      throw new Error(`${side} does not declare options values as arrays of choice ids`);
    }
    if ((value.items as Record<string, unknown> | undefined)?.type !== "string") {
      throw new Error(`${side} does not declare the choice ids as strings`);
    }
  }

  // The declared shape is the shape the server takes: one group id, its choice ids.
  const accepted = orderWith(
    { venue_slug: "doppelt-kaese-berlin", sku: "331227" },
    { "68405": ["366860"] },
  );
  if (accepted.isError) {
    throw new Error(`the server refuses the shape its own schema declares: ${JSON.stringify(accepted)}`);
  }
});

// ===========================================================================
// PLAN-0006 Track D — options. Gap G-c: `order` accepted `options` and did
// nothing with it, and `menu` published `option_group_ids` with no group content.
//
// Every fixture below is the venue's own served data, quoted from
// venues/*/venue.json (read 2026-10-09):
//   doppelt Cheeseburger  sku 331227  pickup 8.90
//     group 68405 "Deine Soße"   required, single-select
//       choice 366859 "Hausgemachte Burgersoße" +0
//       choice 366860 "Getrüffelte Haussoße"    +0.50
//     group 68406 "Deine Extras" multi (max 10)
//       choice 366862 "Speck"            +1.10
//       choice 366863 "Jalapeños"        +0.50
//       choice 366865 "Guacamole"        available: false
//   pizza Pizza Margherita  id 6943882  pickup 9.90  price_level_used size2
//     group 4454494 "Deine Größe" PriceLevelEnum, required, one choice
//       choice 43938710 "Ø 32cm"  discounted_price 9.0  (ABSOLUTE, see R7)
//     group 4454495 "Extrazutaten auf Wunsch" multi
//       choice 43938711 "Ananas"  price_level2 2.70 / list 1.80
// ===========================================================================

const CHEESEBURGER = { venue_slug: "doppelt-kaese-berlin", sku: "331227" } as const;

function orderWith(item: Record<string, unknown>, options?: Record<string, string[]>) {
  return handleToolCall(index, "order", {
    venue_slug: item.venue_slug,
    items: [{ sku: item.sku, qty: 1, ...(options ? { options } : {}) }],
    fulfilment: "pickup",
    when: "asap",
  });
}

function reasonOf(res: { isError?: boolean; content: { text: string }[] }): string {
  const payload = JSON.parse(res.content[0].text) as { error?: string };
  return payload.error ?? "";
}

Deno.test("RED: a required option group left out is refused, naming the group and the item", async () => {
  await setup();
  const res = orderWith(CHEESEBURGER);
  if (!res.isError) throw new Error("a missing required group must be refused, not silently ordered");
  const reason = reasonOf(res);
  if (!/Deine Soße/.test(reason)) throw new Error(`refusal must name the group: ${reason}`);
  if (!/Cheeseburger/.test(reason)) throw new Error(`refusal must name the item: ${reason}`);
});

Deno.test("RED: a choice from another group, and an unknown group, are refused naming both sides", async () => {
  await setup();
  // 366862 (Speck) is a real choice — of group 68406, not of 68405.
  const wrongGroup = orderWith(CHEESEBURGER, { "68405": ["366862"] });
  if (!wrongGroup.isError) throw new Error("a choice from another group must be refused");
  const r1 = reasonOf(wrongGroup);
  if (!/366862/.test(r1) || !/Deine Soße/.test(r1)) {
    throw new Error(`the refusal must name the choice and the group: ${r1}`);
  }

  const unknownGroup = orderWith(CHEESEBURGER, { "99999": ["1"] });
  if (!unknownGroup.isError) throw new Error("an unknown option group must fail loud, never be ignored");
  const r2 = reasonOf(unknownGroup);
  if (!/99999/.test(r2) || !/not offered/.test(r2)) {
    throw new Error(`an unknown group must be named as not offered: ${r2}`);
  }
});

Deno.test("RED: a single-select group takes one choice, and a multi group takes its whole priced max", async () => {
  await setup();
  const two = orderWith(CHEESEBURGER, { "68405": ["366859", "366860"] });
  if (!two.isError) throw new Error("multi_select:false must refuse a second choice");
  if (!/at most one choice/.test(reasonOf(two))) throw new Error(`wrong reason: ${reasonOf(two)}`);

  // 68406 "Deine Extras" publishes ten choices with max_count 10 (raw venue API:
  // `multiply: false` AND `max_count: 10`). R4 reads the count, not the multiply
  // flag, so all eight AVAILABLE extras must be accepted — and the delta must be the
  // sum of the venue's own eight numbers (3.0 + 1.1 + 0.5 + 0.5 + 1.0 + 1.8 + 1.1
  // + 1.9 = 10.9). Measured: NO served group can exceed its own max_count with
  // distinct choices, so this boundary is the reachable form of that rule; the
  // over-limit branch is kept and covered by the single-select case above.
  const all = orderWith(CHEESEBURGER, {
    "68405": ["366859"],
    "68406": ["366861", "366862", "366863", "366864", "366867", "366868", "366869", "366870"],
  });
  if (all.isError) throw new Error(`ten-priced-extras group must accept eight: ${all.content[0].text}`);
  const line = JSON.parse(all.content[0].text).lines[0];
  if (line.options_delta !== 10.9) throw new Error(`expected 10.90 of extras, got ${line.options_delta}`);
  if (line.unit_price !== 19.8) throw new Error(`expected 8.90 + 10.90 = 19.80, got ${line.unit_price}`);

  // The count is a count of DISTINCT choices: the same id twice does not become a
  // second extra, so eight distinct + one repeat stays legal where the group's own
  // limit is 10 (and would still be legal at a limit of 8).
  const nine = orderWith(CHEESEBURGER, {
    "68405": ["366859"],
    "68406": ["366861", "366862", "366863", "366864", "366867", "366868", "366869", "366870", "366870"],
  });
  if (nine.isError) throw new Error("a repeated choice is one choice, not a ninth");
});

Deno.test("RED: an unavailable choice is refused by name", async () => {
  await setup();
  // 366865 Guacamole is in group 68406 with available:false in venue.json.
  const res = orderWith(CHEESEBURGER, { "68405": ["366859"], "68406": ["366865"] });
  if (!res.isError) throw new Error("an unavailable choice must be refused");
  const reason = reasonOf(res);
  if (!/Guacamole/.test(reason) || !/unavailable/.test(reason)) {
    throw new Error(`the refusal must name the unavailable choice: ${reason}`);
  }
});

const MARGHERITA = {
  venue_slug: "pizza-e-pasta-ruedesheimerplatz",
  sku: "100",
  id: "6943882",
} as const;

Deno.test("RED: pizza's option delta is read at the item's OWN size level, not the level-independent one", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: MARGHERITA.venue_slug,
    items: [{
      id: MARGHERITA.id,
      qty: 1,
      options: { "4454494": ["43938710"], "4454495": ["43938711"] },
    }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(`this is a real, priced basket: ${res.content[0].text}`);
  const line = JSON.parse(res.content[0].text).lines[0];
  // Ananas is 2.70 at price_level2 and 1.80 in the level-independent column; the
  // item's own level is size2, so 2.70 is the served number that applies.
  if (line.options_delta !== 2.7) {
    throw new Error(`expected the size-2 delta 2.70, got ${line.options_delta}`);
  }
  if (line.unit_price !== 12.6) {
    throw new Error(`expected 9.90 + 2.70 = 12.60, got ${line.unit_price}`);
  }
});

Deno.test("RED: a PriceLevelEnum choice is the item's own price, so it is not charged twice", async () => {
  await setup();
  // Item 6943882 is 9.90; its required "Deine Größe" choice 43938710 says 9.0.
  // The venue's own rendered page (evidence/rendered-ordering-page.txt) shows the
  // dish at 9,90 €, so 9.90 + 9.00 = 18.90 would be inventing a price.
  const res = handleToolCall(index, "order", {
    venue_slug: MARGHERITA.venue_slug,
    items: [{ id: MARGHERITA.id, qty: 1, options: { "4454494": ["43938710"] } }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(`the venue's own required size choice must be orderable: ${res.content[0].text}`);
  const line = JSON.parse(res.content[0].text).lines[0];
  if (line.options_delta !== 0) {
    throw new Error(`a PriceLevelEnum choice is absolute — delta must be 0, got ${line.options_delta}`);
  }
  if (line.unit_price !== 9.9) {
    throw new Error(`expected the item's own 9.90, got ${line.unit_price}`);
  }
  if (line.options["4454494"][0] !== "43938710") {
    throw new Error("the chosen size must still be recorded on the line, not dropped");
  }
});

Deno.test("RED: a choice the venue prices nowhere is a no-surcharge choice, not a refusal", async () => {
  await setup();
  // pizza group 4454489 "Dressing nach Wahl" is required and its four choices carry
  // no price field at all in the venue's own response ({id, orderBy, title}), and the
  // dish's own description says all dishes come with a dressing of your choice.
  // Refusing would make every salad unorderable.
  const res = handleToolCall(index, "order", {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ sku: "11", qty: 1, options: { "4454489": ["43938692"] } }],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(`the dressing choice carries no surcharge, not an error: ${res.content[0].text}`);
  const line = JSON.parse(res.content[0].text).lines[0];
  if (line.options_delta !== 0) {
    throw new Error(`expected delta 0 for a no-surcharge choice, got ${line.options_delta}`);
  }
  if (line.unit_price !== 11.7) throw new Error(`expected the item's own 11.70, got ${line.unit_price}`);
});

Deno.test("RED: a basket carrying options totals the sum of the served numbers", async () => {
  await setup();
  const res = handleToolCall(index, "order", {
    venue_slug: "doppelt-kaese-berlin",
    items: [
      {
        sku: "331227",
        qty: 2,
        // 8.90 + 0.50 (Getrüffelte Haussoße) + 1.10 (Speck) + 0.50 (Jalapeños) = 11.00
        options: { "68405": ["366860"], "68406": ["366862", "366863"] },
      },
    ],
    fulfilment: "pickup",
    when: "asap",
  });
  if (res.isError) throw new Error(res.content[0].text);
  const payload = JSON.parse(res.content[0].text);
  const line = payload.lines[0];
  if (line.options_delta !== 2.1) throw new Error(`delta 2.10 expected, got ${line.options_delta}`);
  if (line.unit_price !== 11.0) throw new Error(`unit 11.00 expected, got ${line.unit_price}`);
  if (line.line_total !== 22.0) throw new Error(`line total 22.00 expected, got ${line.line_total}`);
  if (payload.total !== 22.0) throw new Error(`basket total 22.00 expected, got ${payload.total}`);

  // The same basket with the SAME choice twice is one choice: 8.90 + 0.50 = 9.40.
  const twice = orderWith(CHEESEBURGER, { "68405": ["366860", "366860"] })
    .content[0].text;
  const twiceLine = JSON.parse(twice).lines[0];
  if (twiceLine.unit_price !== 9.4 || twiceLine.options_delta !== 0.5) {
    throw new Error(`the same choice twice must count once: ${JSON.stringify(twiceLine)}`);
  }
  if (twiceLine.options["68405"].length !== 1) {
    throw new Error("the line must carry the selection once, not twice");
  }
});

Deno.test("RED: menu serves the option catalogue once per venue, with the price rule stated in the data", async () => {
  await setup();
  const payload = JSON.parse(handleToolCall(index, "menu", {}).content[0].text);
  const venues = payload.venues as Array<Record<string, unknown>>;
  if (venues.length === 0) throw new Error("no venues in the menu");

  for (const v of venues) {
    const groups = v.option_groups as Array<Record<string, unknown>>;
    if (!Array.isArray(groups)) throw new Error(`${v.venue_slug} serves no option catalogue`);
    // The catalogue is served ONCE: no group id may be repeated (R6).
    const ids = groups.map((g) => g.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${v.venue_slug} repeats an option group id: ${JSON.stringify(ids)}`);
    }
    if (typeof v.option_price_rule !== "string" || !/price_level_key/.test(String(v.option_price_rule))) {
      throw new Error(`${v.venue_slug} does not state the served price rule`);
    }
    for (const g of groups) {
      if (typeof g.absolute_price !== "boolean") {
        throw new Error(`group ${g.id} carries no absolute_price flag`);
      }
      const choices = g.choices as Array<Record<string, unknown>>;
      if (!Array.isArray(choices)) throw new Error(`group ${g.id} serves no choices`);
      if (g.required === true && Number(g.min_count) < 1) {
        throw new Error(`required group ${g.id} must have min_count >= 1`);
      }
      if (g.multi_select === false && Number(g.max_count) !== 1) {
        throw new Error(`single-select group ${g.id} must serve max_count 1, got ${g.max_count}`);
      }
      for (const c of choices) {
        if (typeof c.prices !== "object" || c.prices === null) {
          throw new Error(`choice ${c.id} serves no prices object`);
        }
        if (typeof c.available !== "boolean") throw new Error(`choice ${c.id} serves no availability`);
      }
    }
    // Every item must say which key its own prices are read at, and every id it names
    // must resolve in the catalogue it was served with.
    const byId = new Set(ids);
    for (const it of v.items as Array<Record<string, unknown>>) {
      const gids = it.option_group_ids as string[];
      if (!Array.isArray(gids)) throw new Error(`item ${it.sku} serves no option_group_ids`);
      if (typeof it.price_level_key !== "string") {
        throw new Error(`item ${it.sku} serves no price_level_key`);
      }
      for (const gid of gids) {
        if (!byId.has(gid)) {
          throw new Error(`item ${it.sku} names group ${gid}, which the catalogue does not serve`);
        }
      }
    }
  }

  // The one fixture the money tests use: Margherita at size2, Ananas priced 2.70.
  const pizza = venues.find((v) => v.venue_slug === "pizza-e-pasta-ruedesheimerplatz")!;
  const margherita = (pizza.items as Array<Record<string, unknown>>).find((it) => it.id === "6943882")!;
  if (margherita.price_level_key !== "2") {
    throw new Error(`Margherita's level key must be the size-2 key, got ${margherita.price_level_key}`);
  }
  const extras = (pizza.option_groups as Array<Record<string, unknown>>).find((g) => g.id === "4454495")!;
  const ananas = (extras.choices as Array<Record<string, unknown>>).find((c) => c.id === "43938711")!;
  const prices = ananas.prices as Record<string, number>;
  if (prices["2"] !== 2.7 || prices.default !== 1.8) {
    throw new Error(`Ananas must serve both columns verbatim, got ${JSON.stringify(prices)}`);
  }
  const sizeGroup = (pizza.option_groups as Array<Record<string, unknown>>).find((g) => g.id === "4454494")!;
  if (sizeGroup.absolute_price !== true) {
    throw new Error("the PriceLevelEnum size group must be served absolute_price:true");
  }
});
