# PROGRESS — t_5b352cfb (ADR-0009 Class 2 account creation + login, pizza-e-pasta)

Workspace: /home/c03rad0r/worktrees/t_5b352cfb  (clone of cvm-services/contextvm-services @ 9d50207)

- [x] Orient: read ADR-0007/0009, venue.json, adapter.py, capture evidence, server.ts (877 lines, menu+order only), orderyoyo-venue-adapter skill.
- [ ] Recon the OrderYoyo consumer-auth flow on the venue's own rail (browser, read-only).
- [ ] Write the plan (session handling / secret custody / re-login detection / ban mid-order) -> docs/plans/.
- [ ] Cold cross-family review of the plan.
- [ ] Implement Class 2 per-venue opt-in adapter (create-account + login) with private local custody.
- [ ] Real account created + real login observed on the venue's own rail (secret redacted).
- [ ] Test: non-owner caller cannot obtain credential material.
