# PROGRESS — t_5b352cfb (ADR-0009 Class 2 account creation + login, pizza-e-pasta)

Workspace: /home/c03rad0r/worktrees/t_5b352cfb  (clone of cvm-services/contextvm-services @ 9d50207)
Branch: worker-base/t_5b352cfb  (pushed to origin after every commit)

## Map of what exists

- [x] Orient: ADR-0007/0009, venue.json, adapter.py, capture evidence, server.ts (877 lines, menu+order
      only, no session/cookie/auth code), orderyoyo-venue-adapter + contextvm skills.
- [x] Recon script written: venues/pizza-e-pasta-ruedesheimerplatz/evidence/recon-auth-flow.py
      (read-only, one headed session on the existing persistent profile, redacted output).
- [x] Plan first deliverable: docs/plans/PLAN-0008-venue-account-login.md
      D1 custody split · D2 no material in CVM/announcement · D3 browser profile not cookie replay ·
      D4 two-layer stale detection + bounded one-shot re-login · D5 ban = terminal + ADR-0012 escalation ·
      D6 login generation/custody · D7 per-venue opt-in in venue.json · D8 written risk record ·
      D9 CVM-side stub + owner gate · D10 out of scope. Tests T1–T6, criteria A1–A7.
- [x] Repo suite green in this worktree: `deno task test` => 81 passed, 0 failed, 1 ignored.

## Commits (all pushed to origin/worker-base/t_5b352cfb)

- 115f111 recon: read-only OrderYoyo consumer-auth flow probe + PROGRESS.md
- f5b3e35 recon: wait out the CF managed challenge before declaring a block
- c1dd817 plan: PLAN-0008

## Open blockers (recorded on the card, comment 481)

- B1 EVIDENCE (A2/A3): the origin refuses every headed navigation from this host this week —
  3 × ~180 s waits, all HTTP 403 "Nur einen Moment…" (Cloudflare managed challenge). Needs a cooldown,
  a different egress, or an operator decision. NOT a code problem.
- B2 REVIEW: flat router 503s on every non-deepseek lane; ~/scripts/cold_review_runner.py also reads
  message.reasoning_content while the live lane returns message.reasoning (a model that answered was
  reported as "empty completion"). A fixed retry runner is running; no verdict is claimed until a real
  one lands in docs/reviews/.

## Next steps (in order)

1. Land the cold review verdict (docs/reviews/PLAN-0008-cold-review.md) once the router yields one.
2. Venue record: venue.json `account` block + README "risk and custody" section +
   announcement tag-set test (T2 / A6 / A7).
3. CVM-side stub + types + the non-owner test (T3 / A4).
4. Local adapter in a PRIVATE repo outside the org (secret store, profile, status/ensureSession/create,
   loopback Unix socket).
5. Live proof A2/A3, gated on B1.
