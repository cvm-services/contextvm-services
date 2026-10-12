# Steglitz manual end-to-end test — operator runbook

**Status: READY** (2026-10-12). Both Steglitz identities are announced and
served live; both machine e2e runs are green (see below). What remains is the
HUMAN part of the human-handoff test: pick a venue, order by hand, collect.

## What is live right now

| venue | identity (npub) | announced relays | server unit | machine e2e |
|---|---|---|---|---|
| **Three Buddies** (Albrechtstr. 131, 12167) | `npub1cdykhpm74g886v5dqjm53e6v3536yy8jc5a4gx7rutreaqnm43uqxvzvg2` | relay2.orangesync.tech, relay.primal.net | `venue-cvm-server-three-buddies.service` | **all_passed: True** (menu 100 items, hash 38f4466251fc, basket 13.50 EUR) |
| **La Mama Steglitz** | `npub1nlet55u0h2xvdskr0j833s0ek5m6mj0pz4ykf8fkrkhzx8v8uchqxnw0zd` | relay2.orangesync.tech, relay.primal.net | `venue-cvm-server-la-mama.service` | **all_passed: True** (menu 104 items, hash a22d5f6ddae7, basket 18.50 EUR) |
| Chandi | `npub1…` (see `~/.hermes/secrets/venues/chandi-berlin.nsec`) | relay2 + primal | `venue-cvm-server-chandi.service` | served, not re-run this round |
| Doreedos | (key exists, no unit yet) | — | — | served record verified by suite |

Everything serves from the production checkout (`~/repos/contextvm-services`,
main @ `674d1d9`) — anchored records, merged code, one shared venue hasher.

## The machine-run (I do this; already green for both)

```bash
cd ~/repos/contextvm-services
HEX=$(nak key public < .scratch/three-buddies.nsec)   # server pubkey hex
deno run --allow-net --allow-read --allow-env services/restaurant-cvm/e2e_client.ts \
  --server $HEX --relay wss://relay2.orangesync.tech --venue three-buddies-berlin --json
```
Expected: `all_passed: true`, four checks green, order returns a `basket` with
`deep_link`. Transcripts already committed:
`evidence/three-buddies-live-e2e.json`, `evidence/la-mama-live-e2e-post41.json`.

## THE MANUAL TEST (you, at the venue)

1. **Read the menu over Nostr** — with any MCP-capable CVM client pointed at
   the venue npub above (relays: `wss://relay2.orangesync.tech`), call
   `menu`. You get the venue's full catalogue: names, prices, EUR, pickup/delivery.
   *No app needed: I can drive the client for you here in chat — say the word
   and I'll fetch the live menu and paste it.*
2. **Compose the order** — pick real items, call `order` with the basket.
   The CVM returns: priced lines, total, and the venue's own deep link +
   human steps. It places NOTHING (Stage 1 contract — the handoff is yours).
3. **Place the order like a human** — telephone Three Buddies
   (+49 30 … see menu reply `cvm:req:contact.phone`) or use their web page
   (`https://www.threebuddies.de/speisekarte/threebuddies`), and say exactly
   what the basket said: items, quantities, pickup, asap.
4. **Record the receipt** — order number or staff name + time. That is the
   venue's own confirmation; the CVM's contract says this IS the receipt.
5. **Tell me** the basket you sent vs what you ordered vs the receipt, and I
   file the evidence + close the e2e card.

**Money:** the venue is paid on its own page or at collection (Stage 1:
payment authority is the human, `cvm_cap_sats: 0`). No Lightning leg in this
test — that's the Stage-2 facilitator flow, not this one.

**Why Three Buddies is the best first venue:** 100 items, all exact prices,
pickup + delivery, food you can carry out. La Mama is the fallback (also
green; 44 of its prices are starting prices and the menu says so).

## Known sharp edges (fixed this round — recorded so you can spot regressions)

- Menu replies are ~110 KB signed events. Any relay that keeps strfry's
  64 KB default will drop them (silent timeout). relay2 is now 256 KB —
  `events{maxEventSize=262144}` + `relay{maxWebsocketPayloadSize=262144}`
  (`/opt/tollgate/strfry/strfry.conf` on vps2). Primal still caps at 64 KB,
  so **menu fetches must go via relay2**; order replies fit everywhere.
- Two instances of one npub on the same relay set = reply races, wrong hashes.
  One unit per identity, nothing manual left running.