# REPORT — republish both venue announcements from main (card t_4c1f654f)

Branch `pr/republish-announcements` (from origin/main e8be7ab), commits
`e6aaef3` + `80e5094`, both pushed to origin. Working tree clean.

## Outcome: DONE — all acceptance items evidenced

1. **Dry-run lists pasted** → kanban card comment #163 (both venues, both
   kinds; required: order.items, order.fulfilment, order.when, contact.phone;
   ship.address optional; NOT re-required).
2. **No settlement declared** — cap `["cap","tool:order","0","sats"]`
   unchanged, no payment.method/pmi tag, content settlement unchanged
   (doppelt rail = descriptive only; pizza rail null). No BLOCKER.
3. **Published + read back per relay** — 4 events (2 venues × kinds
   11316/11317) signed once per event with the venue key, published to
   wss://relay.primal.net, identical signed event replayed to
   wss://relay2.orangesync.tech. Every relay's read-back (fresh REQ by id, new
   socket) confirmed: required list with order.items/order.when, tier
   cvm:tier:fulfilment, classes [meatspace, restaurant], cap 0 sats, pubkey =
   intended venue identity (doppelt fe700a09…, pizza ef070a5d…). Event ids:
   doppelt 11316 `399f972a…` / 11317 `7b6a4010…`; pizza 11316 `a41f4e5c…` /
   11317 `ace6d6ec…`.
4. **relay2 did not refuse** — the card's premise (66–77 KB events vs strfry
   65536 maxEventSize) is stale: merged main's emitter publishes menu
   summaries, so events are ~5.6 KB. relay2 accepted all four (`OK …
   accepted=true`, empty msg) and serves them by id. No refusal text exists
   because there was no refusal. vps-infra/t_e4500c96 not needed for this
   publish (stays valid for its own gift-wrap finding).
5. **Live catalog re-checked** — refreshed on the first poll:
   generated_at `2026-10-07T21:02:57Z` (before: `20:32:55Z`); all four
   entries carry the new event ids with
   `required: [contact.phone, order.fulfilment, order.items, order.when]`,
   `optional: [contact.name, order.notes, ship.address]`, tier
   `mismatch=false`. Stage-1 schema is live for clients.

## What changed in the repo (evidence only, no schema/tool/code changes)

- `evidence/announcements/{slug}.{11316,11317}.json` refreshed (dry-run
  convention). `tools/venue_announcement_test.ts`: 16 passed | 0 failed.
- `evidence/republish-2026-10-07.md` — full per-relay read-back table.
- PROGRESS.md appended.

## Honest notes

- The live 11317 previously published an EMPTY order inputSchema; this publish
  is what makes the Stage-1 schema visible (the repo's `order.items`/
  `order.when` and the tool schema had never reached the relays).
- Emitter CLI defect found (pre-existing, NOT fixed here — out of scope by the
  card's hard rule): `tools/nostr.ts publish()` never closes the WebSocket, so
  the CLI hangs after the relay verdict; run it under `timeout(1)`. Worth a
  small follow-up PR.
- Key handling: temp bare-nsec files derived 0600 outside the repo from
  ~/.hermes/secrets/venues/*.nsec (env-format), wiped after use; secrets never
  printed, never on argv, never committed.
- Old event ids now replaced (NIP-16 replaceable range): doppelt 11316
  `9d8f6156…`, 11317 `c8aa7753…`; pizza 11316 `b98a26d6…`, 11317 `2d4faafe…`.
