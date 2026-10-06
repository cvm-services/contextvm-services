# Progress — venue CVM server (Stage 1)

2026-10-06: Read PLAN-0005, service-inputs register, both venue.json files, reference servers, and existing venue_to_announcement.ts; identified the two-venue data model and the pizza price schema gap.
2026-10-06: Created worktree `~/worktrees/cs-venue-server` branch `pr/venue-server` from `origin/main`.
2026-10-06: Wrote RED tests and the venue server implementation under `services/restaurant-cvm/`; `deno task test` green.

2026-10-06: RELAY E2E cluster — baseline re-verified (64 passed | 0 failed). Identity reconciled: live relay2.orangesync.tech shows doppelt 11316/11317 under fe700a09 (matches the venue nsec NPUB exactly); pizza under ef070a5d. ae317038 is a stale hardcoded test fixture (tests/attestation_test.ts, review_event_test.ts, evidence dry-run); 2a9d186d appears NOWHERE in the repo or git history. Transport audit: server serve() wire shape (inner kind 25910 + NIP-59 gift wrap 1059/21059, #p addressing) matches @contextvm/sdk constants exactly. Found + fixed: CLI ignored any relay config (hardcoded nostr.mom+primal, and nostr.mom is NOT an announced relay) — added parseRelayList() + VENUE_SERVER_RELAYS with RED test first; suite 65 passed | 0 failed. Files: services/restaurant-cvm/server.ts, server_test.ts, e2e_client.ts (new), run-venue-server.sh (new).
