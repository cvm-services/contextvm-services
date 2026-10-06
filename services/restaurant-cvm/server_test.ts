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
} from "./server.ts";

let index: VenueIndex;

async function setup() {
  index = await buildIndex();
}

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
    items: [{ sku: "331227", qty: 1 }],
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
      { sku: "331227", qty: 2 },
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
