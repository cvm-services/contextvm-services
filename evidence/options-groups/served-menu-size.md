# Serving the option groups: what it costs the `menu` reply

Task: PLAN-0006 Track D (absorbed as PLAN-0007 T5), kanban `t_f881bb6a`.
Measured 2026-10-09 with `deno run --allow-read tools/menu_size.ts` and
`tools/menu_frame_size.ts` against `venues/*/venue.json`.

## Why the number matters

The `menu` reply is not the menu JSON. It is an inner kind-25910 event whose content
is the MCP response (which itself carries the menu JSON as a **string**), NIP-44
encrypted into a kind-1059 gift wrap, published as
`["EVENT", …]`. Every layer adds size — JSON-in-JSON escaping, then base64 — so
checking the menu JSON alone understates what a relay enforces. That is exactly how
`evidence/relay-e2e/FINDING-3-menu-frame-exceeds-relay-cap.md` was missed the first
time (the 131595 B frame was our own 77348 B response).

## The two shapes

AC1 read literally is "per item, the groups it offers". Materialising that inside all
188 items:

| scope | payload | inner | encrypted | event | frame |
|---|---|---|---|---|---|
| per-item form, all venues | 508939 | 648198 | 873908 | **874325** | **874335** |

Served instead as **one catalogue per venue** (R6 in `tools/venue_option_groups.ts`):
the venue carries `option_groups` once and each item carries the group **ids** it
offers plus `price_level_key`:

| scope | payload | inner | encrypted | event | frame |
|---|---|---|---|---|---|
| catalogue form, all venues | 139910 | 183025 | 262240 | 262657 | 262667 |
| catalogue form, pizza only | 97373 | 127562 | 174860 | 175277 | 175287 |
| catalogue form, doppelt only | 42578 | 56033 | 76548 | 76965 | 76975 |

Caps (strfry defaults, unchanged): `maxEventSize` **65536** on the event,
`maxWebsocketPayloadSize` **131072** on the frame.

Catalogue form is **6.2× smaller** than the per-item form — the difference between a
reply that is merely over the event cap and one that is over every cap by a wide
margin. It is still not deliverable on relay2: see below.

## What this changes versus FINDING-3 (2026-10-06, before options were served)

| scope | response then | frame then | response now | frame now |
|---|---|---|---|---|
| all venues | 77348 | 131595 (REJECTED) | 139910 | 262667 (REJECTED) |
| doppelt only | 35317 | 66055 | 42578 | 76975 |
| pizza only | 42153 | 76975 | 97373 | **175287 (REJECTED)** |

Two honest consequences:

1. **No new functional loss on relay2, but the margin is gone.** Every one of these
   replies already exceeded strfry's 65536-byte **event** cap before this change
   (measured then: `publish warning: invalid: event too large: 66045` / `76965`), so
   relay2 already refused them; primal carried them. FINDING-3's frame-cap table was
   about the *frame*, which per-venue menus used to fit.
2. **The pizza menu now also exceeds the 131072-byte FRAME cap** — 175287 B. So
   "raise `maxEventSize` and we are fine" is no longer sufficient: pizza needs the
   frame cap raised too, or a paged/leaner menu. That is G-b / relay-side work, carded
   separately (PLAN-0006 lists it as `ours (infra)`, "reachability, not correctness"),
   and NOT done here.

## Where the 52 KB on pizza goes

The venue's own `menu.option_groups` is 41850 B compact for 18 groups / 185 choices
(measured). Served, each choice carries `id`, `name`, `available` and a `prices`
object holding only the columns the venue published numerically, and each group
carries its own limits and flags; each item adds `price_level_key` (112 items,
~2.8 KB) and the venue adds `option_price_rule` once (~0.3 KB). The rest is the
choices themselves — the price data AC1 requires and the client cannot get anywhere
else.

## Reproduce

```
deno run --allow-read tools/menu_size.ts        # payload sizes, per component
deno run --allow-read tools/menu_frame_size.ts  # payload -> inner -> encrypted -> event -> frame
```
