# Announcement status — three-buddies-berlin

**STATUS: PUBLISHED 2026-10-12 (operator-approved).** Live under the venue's
own key `npub1cdykhpm74g886v5dqjm53e6v3536yy8jc5a4gx7rutreaqnm43uqxvzvg2`
(hex `c3496b877eaa0e7d328d04b748e74c8d23a210f2c53b541bc3e2c79e827bac78`):

- kind 11316 event id `cd628810a2ce1146…` (relays: relay2.orangesync.tech)
- kind 11317 event id `92745cef42cf7877…` (relays: relay2.orangesync.tech)

Read-back verified via live REQ against `wss://relay2.orangesync.tech`
(both kinds returned under `authors=[c3496b87…]`). The serving unit is
`deploy/venue-cvm-server-three-buddies.service`; the key file is
`~/.hermes/secrets/venues/three-buddies-berlin.nsec` (0600, operator-held).
Live e2e transcript: `evidence/three-buddies-live-e2e.json` —
`all_passed: true`, menu sha256 `38f4466251fc==38f4466251fc`, order basket
total 13.50 EUR over the announced relay set.

**Relay prerequisite found the hard way:** the menu reply is a ~110 KB signed
event; strfry's defaults (`events.maxEventSize` 65536, `relay.maxWebsocketPayloadSize`
131072) reject it. `relay2.orangesync.tech` (tollgate-strfry on vps2) was raised
to `maxEventSize = 262144` and `maxWebsocketPayloadSize = 262144`
(`/opt/tollgate/strfry/strfry.conf`, backup `strfry.conf.bak-20261012`) —
note the correct block is top-level `events{}`, NOT inside `relay{}`.

The dry-run evidence files below remain as the pre-publication record.

The venue records are announced the same way the other two venues are: one
`11316` (server announcement) and one `11317` (tool list) per venue, built by
`tools/emit-venue-announcement.ts`, following CEP-6 / docs/adr/0001.

## Evidence committed (repo root, the same directory as the other venues)

| file | bytes | sha256 | kind | tier |
|---|---|---|---|---|
| `evidence/announcements/three-buddies-berlin.11316.json` | 5453 | `a5f057c9673305a7ce59cde96932857ae9fbe81ba3f23820afade8ddc5511c1e` | 11316 | `cvm:tier:fulfilment` |
| `evidence/announcements/three-buddies-berlin.11317.json` | 3379 | `b5b8ac65ff256d79ff69c621da3146c28dc4ac363ccf354cea8cbd16db92c31f` | 11317 | `cvm:tier:fulfilment` |

The 11316 payload carries `menu.price_semantics` — `from_priced_count: 0`,
`exact_priced_count: 100`, `from_qualifiers: []` — because this venue publishes an
exact price for every listed item and carries no starting-price qualifier. The field
is emitted for every venue so that a venue whose prices ARE floors (la-mama) cannot
be announced without saying so.

Both were produced by:

```
deno run --allow-read tools/emit-venue-announcement.ts \
  --venue venues/three-buddies-berlin/venue.json --kind 11316 --dry-run \
  > evidence/announcements/three-buddies-berlin.11316.json
deno run --allow-read tools/emit-venue-announcement.ts \
  --venue venues/three-buddies-berlin/venue.json --kind 11317 --dry-run \
  > evidence/announcements/three-buddies-berlin.11317.json
```

`warnings: []` in both files, and the emitter asserts the emitted tier equals the
recomputed tier before it prints anything.

## What the operator must run to publish (NOT run here — no key)

```
# 1. A key for THIS venue ONLY. kinds 11316/11317 are replaceable and relays key
#    them by (kind, pubkey) alone, so reusing an existing venue's key would
#    SILENTLY OVERWRITE that venue's announcement. One key per venue.
umask 077
nak key generate > .scratch/three-buddies.nsec   # operator-held, never committed

# 2. Publish both kinds, then read them back.
deno run --allow-read --allow-net tools/emit-venue-announcement.ts \
  --venue venues/three-buddies-berlin/venue.json --kind 11316 \
  --key-file .scratch/three-buddies.nsec --relays wss://relay2.orangesync.tech
deno run --allow-read --allow-net tools/emit-venue-announcement.ts \
  --venue venues/three-buddies-berlin/venue.json --kind 11317 \
  --key-file .scratch/three-buddies.nsec --relays wss://relay2.orangesync.tech

# 3. Prove it landed (the read-back is the evidence, as in evidence/S5a-live-announcement.md).
nak req -k 11316 -a <venue npub> -t 't=three-buddies' wss://relay2.orangesync.tech
```

The venue CVM must then also be started for the announced identity (see
`deploy/venue-cvm-server*.service`; one unit per announced key).
