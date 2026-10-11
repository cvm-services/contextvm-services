# Announcement status — three-buddies-berlin

**STATUS: NOT PUBLISHED.** No live Nostr event exists for this venue. The two
files that would be published are committed as dry-run evidence only, and both
carry `"pubkey": null` (nothing is signed without a key).

The venue records are announced the same way the other two venues are: one
`11316` (server announcement) and one `11317` (tool list) per venue, built by
`tools/emit-venue-announcement.ts`, following CEP-6 / docs/adr/0001.

## Evidence committed (repo root, the same directory as the other venues)

| file | bytes | sha256 | kind | tier |
|---|---|---|---|---|
| `evidence/announcements/three-buddies-berlin.11316.json` | 5235 | `e17aa0e905f114fad3df2b186b522420d7b45e2f8a01fc9a569fa8f232b469e0` | 11316 | `cvm:tier:fulfilment` |
| `evidence/announcements/three-buddies-berlin.11317.json` | 3379 | `b5b8ac65ff256d79ff69c621da3146c28dc4ac363ccf354cea8cbd16db92c31f` | 11317 | `cvm:tier:fulfilment` |

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
