# Report -- venue CVM server (Stage 1)

## What was built

- `services/restaurant-cvm/server.ts` -- a Deno CVM server that exposes two MCP tools:
  - `menu`: returns the full 188-item catalogue from `venues/*/venue.json`, with
    `sku`, `name`, `prices_by_order_method`, `available`, `allergens`, and
    `option_group_ids`.
  - `order`: validates a basket against the menu, computes a per-fulfilment-method
    total, enforces the conditional delivery-address rule, and returns a basket
    plus the venue's rail and deep-link. It does **not** place, settle, or pay
    anything.
- `services/restaurant-cvm/server_test.ts` -- RED-first tests covering:
  - `tools/list` shape and real `order` inputSchema
  - 188 menu items and a known SKU price match
  - unknown-SKU failure
  - `ship.address` required only for `delivery`
  - response is a basket, not "order placed"
- Updated `tools/venue_to_announcement.ts` to emit the real `order` tool schema
  instead of the zero-argument placeholder, and updated declared required/optional
  fields to match (`order.items`, `order.fulfilment`, `order.when`, `contact.phone`,
  `ship.address` optional, etc.).
- `PROGRESS.md` appended at worktree root.

## Test command and real tail

```
cd /home/c03rad0r/worktrees/cs-venue-server
deno task test
```

Tail of the actual run:

```
running 10 tests from ./services/restaurant-cvm/server_test.ts
RED: tools/list exposes menu and order with real schemas ... ok
RED: menu returns 188 items with sku, name, prices, available, allergens ... ok
RED: a known sku price matches venue.json exactly ... ok
RED: order with an unknown sku fails loud ... ok
RED: delivery requires ship.address; pickup and dine_in do not ... ok
RED: order returns basket + rail + deep-link, not 'order placed' ... ok
loadVenues loads two venues with 188 total items ... ok
tools/call returns unknown-tool error ... ok
initialize returns serverInfo ... ok
order fails loud for sku not in chosen venue ... ok
menu filter by venue_slug returns only that venue ... ok
...
ok | 59 passed | 0 failed (6s)
```

(The full suite includes 49 pre-existing tests; all 59 pass.)

## Menu item count

188 items served (76 doppelt-kaese-berlin + 112 pizza-e-pasta-ruedesheimerplatz).

## Data caveat handled honestly

`pizza-e-pasta-ruedesheimerplatz/venue.json` does **not** contain
`prices_by_order_method` per item; its menu was captured for `pickup` only. The
server wraps the item's `price` into `{ pickup: price }` so the published field
shape is consistent, without retyping any price. Delivery prices for this venue
are not in the source data; the order response notes when a fallback method is
used.

## What was not verified

- No live relay run was attempted. `deno task test` is green with `--allow-read`
  only; `deno task test:net` (which exercises relay publish/read-back) was not
  run because it requires network and the server test path is local.
- The CLI `serve()` path using `SERVER_HEX` was not exercised end-to-end against
  a real CVM client; only the `handleMcpMessage`/`handleToolCall` paths are
  tested.
- The updated `venue_to_announcement.ts` content (new `order` tool schema) was
  not re-published to relays; existing committed evidence files under
  `evidence/announcements/` are unchanged.
- `order.channel` (the explicit rail/versioning field from acceptance criterion
  5 of PLAN-0005) is not implemented as a separate argument; the rail is
  identified via `venue_slug`. This should be discussed in the PR.

## PR

Branch `pr/venue-server` pushed; PR opened against `main` (not merged, per
operator rule).
