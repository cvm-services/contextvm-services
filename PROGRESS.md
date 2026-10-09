# Progress — venue CVM server (Stage 1)

2026-10-06: Read PLAN-0005, service-inputs register, both venue.json files, reference servers, and existing venue_to_announcement.ts; identified the two-venue data model and the pizza price schema gap.
2026-10-06: Created worktree `~/worktrees/cs-venue-server` branch `pr/venue-server` from `origin/main`.
2026-10-06: Wrote RED tests and the venue server implementation under `services/restaurant-cvm/`; `deno task test` green.

2026-10-06: RELAY E2E cluster — baseline re-verified (64 passed | 0 failed). Identity reconciled: live relay2.orangesync.tech shows doppelt 11316/11317 under fe700a09 (matches the venue nsec NPUB exactly); pizza under ef070a5d. ae317038 is a stale hardcoded test fixture (tests/attestation_test.ts, review_event_test.ts, evidence dry-run); 2a9d186d appears NOWHERE in the repo or git history. Transport audit: server serve() wire shape (inner kind 25910 + NIP-59 gift wrap 1059/21059, #p addressing) matches @contextvm/sdk constants exactly. Found + fixed: CLI ignored any relay config (hardcoded nostr.mom+primal, and nostr.mom is NOT an announced relay) — added parseRelayList() + VENUE_SERVER_RELAYS with RED test first; suite 65 passed | 0 failed. Files: services/restaurant-cvm/server.ts, server_test.ts, e2e_client.ts (new), run-venue-server.sh (new).

2026-10-06: CRITERION 7 — MET on wss://relay.primal.net (initialize + tools/list + menu 188 + a real order basket, 4/4, repeated, serving as the announced identity fe700a09) and BLOCKED on wss://relay2.orangesync.tech, which is where the venues are announced: relay2-only runs time out with zero responses and the server logs 13 replies abandoned on a closed relay2 connection. Fresh-connection publishes to relay2 succeed at 5B and 8KB, so relay2 is neither down nor size-limited nor auth-gated — long-lived subscribed sockets are being reaped. Details: evidence/relay-e2e/FINDING-relay2-carries-discovery-but-not-conversation.md. The republish is gated on fixing relay2, not on the server existing. Server left running, booted with VENUE_SERVER_RELAYS including primal.

2026-10-06: SUPERVISION — the server first left running as a session-owned background child did NOT survive (pgrep 0; a client run timed out against nothing), so the "left running" claim was retracted and replaced with a real user unit: deploy/venue-cvm-server.service, enabled --now, Linger=yes so it outlives the session, Restart=always. Verified after restart: active+enabled, 1 process, 2/2 relays connected, and a fresh e2e run 4/4 all_passed over primal. A service in a worktree is the weak part: repoint it at the deployed checkout once relay-e2e is merged.

2026-10-06: PIZZA-IDENTITY cluster — finding: one venue CVM process serves BOTH venues (menu+order across doppelt AND pizza), signed by a single key, so a client that discovers pizza via its announced pubkey ef070a5d gets nothing while the server answers as fe700a09. Status: added VENUE_SERVER_VENUES per-venue filter to server.ts (parseVenueFilter + loadVenues/buildIndex/serve filter param), RED tests first (proved failing: TS2305 missing export), then GREEN (69 passed | 0 failed), wired run-venue-server.sh + --allow-env. Files: services/restaurant-cvm/server.ts, server_test.ts, run-venue-server.sh.

2026-10-06: PIZZA-IDENTITY cluster — deploy+proof: added deploy/venue-cvm-server-pizza.service and set VENUE_SERVER_VENUES=doppelt-kaese-berlin on the doppelt unit; installed BOTH as systemd --user units (enabled --now, Linger yes). Both running 1:1 with announcements: doppelt 76 items/fe700a09, pizza 112 items/ef070a5d. Extended e2e_client.ts with --venue. Proof over wss://relay.primal.net: pizza (ef070a5d) menu=112 pizza-only + real basket (Vitamalz 2.70, deep_link), doppelt (fe700a09) menu=76 doppelt-only + basket 22.30 — both all_passed. Files: deploy/*.service, e2e_client.ts, evidence/pizza-identity/*.json|log, REPORT.md. Not merged; no announcement published (manager-gated). Note: relay2 also rejects the large menu gift-wraps with 'event too large' (separate finding).
- publish path: sequential relay publish adds one silent relay's 4.4s library timeout to every reply (NOT suppression; corrected 2026-10-06) -> concurrent + per-relay deadline (c848c8b, PR #17), 4 RED tests, 73/0
- publish path: nostr-tools enableReconnect/enablePing unset -> dropped relay dead for process lifetime; now on (89d6f0d), net test proves reconnect+resubscribe, 74/75 green
- relay2 quantified relay-side: 2635x 1006/EAGAIN + 215x ping-timeout + >128KiB frame rejects per 90min (7a3578a). primal-only 4/4 reproducible.
- pizza identity: one instance per announced key (PR #16), all_passed 4/4 both venues. REPORT.md has the full account.

# t_f881bb6a — Options resolution (PLAN-0006 Track D / PLAN-0007 T5, gap G-c)

Branch `pr/options-groups`, PR https://github.com/cvm-services/contextvm-services/pull/35

- 2026-10-09 (attempt 3 resumed attempt 2's uncommitted tree): server half found already
  written and green — tools/venue_option_groups.ts (one model, shared by the server and
  the announcement adapter), server.ts menu catalogue + order validateOptions(), 10 RED
  tests proven against the branch base. Committed as 2878bb9, pushed, PR #35 opened.
- 2026-10-09: AC6 docs — `order.items[].options` added to docs/spec/service-inputs.md and
  vocab/service-inputs.json; new options-shape drift test (RED proven against 7aa2829 in
  evidence/options-groups/RED-options-schema-shape-against-prework-server.log). 91/91 green.
- STILL OPEN: AC5 live e2e with an options basket; coverage evidence; cold cross-family
  review published to PR #35; client OptionPicker (cvm-registry site/order, branch
  pr/customer-order-pwa); consolidation/merge.
