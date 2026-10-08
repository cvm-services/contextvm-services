# ADR-0006 — Client vehicle for facilitated orders: thin PWA, no wallet fork, deferred Android

- **Status:** **Accepted 2026-10-08** — operator approved the mockups (*"yes these
  mockups look good"*) and instructed: *"schedule all of this work with soon
  priority ... with your recommendations"*.
- **Date:** 2026-10-08
- **Tier:** docs/light
- **Depends on:** ADR-0004 (option B, Cashu before bolt11), ADR-0005 (presentation
  is client-side, catalog-constrained). Implements PLAN-0007 D11.
- **Question:** what is the customer app and the facilitator console actually built
  as — native Android, a fork of `wallet.cashu.me`, or something else?

## Decision

1. **Customer client = a thin PWA served from the registry origin**
   (`cvm.orangesync.tech/order/`), catalog-constrained per ADR-0005, growing the
   existing dashboard rather than starting a new app or framework.
2. **The customer client holds no money.** The paid leg issues a **bolt11 invoice**
   (routstrd, NUT-04) which the customer pays with **any** Lightning wallet they
   already have. No keys, no custody, no mint management, no proofs in the browser.
3. **Facilitator console = `/console/` on the same origin**, desktop-oriented,
   authenticated by **sign-in-with-Nostr** (the console signs a challenge with the
   facilitator npub). No password infrastructure.
4. **Android is deferred**, not rejected: if a store listing or shareable APK is
   ever wanted, wrap the *same* PWA with **Capacitor** or ship a **TWA** — the
   pattern is proven by `cashubtc/cashu.me` itself.

## Why not native Android (v1)

Cost without a matching need: slower iteration, key-signing and distribution
burden, a second codebase for a two-venue demo, and the fleet's only Android rail
(the nosms emulator work) is itself still pending. The one real gain — push
notifications for order status — is already covered by **installed-PWA web push**
on Android Chrome and iOS 16.4+.

## Why not fork `cashubtc/cashu.me`

Verified facts (2026-10-08, primary sources): MIT, 217★, actively pushed
2026-09-28, TypeScript **Quasar (Vue 3) PWA with a Capacitor Android config
already present**, built on `@cashu/cashu-ts ^4.9` + NDK + nostr-tools, vitest +
playwright. A strong codebase — and still the wrong vehicle:

- **Inverted information architecture.** Their home is balance / send / receive;
  ours is venues / menu / basket. We would delete most screens and keep plumbing
  → a large, permanently unmergeable diff against an active upstream (fork tax).
- **It solves a problem we do not have.** Its value is wallet internals (mints,
  proofs, token storage) — exactly what decision 2 above removes from scope.
- **Brand disassociation** work would be required before publishing a fork. Our
  own preference is **fork-first stacking for *contribution*** — not product forks.

It stays in the record as **MIT reference** for cashu-ts usage patterns and as the
**existence proof** of the PWA → Capacitor path we may later take.

## Consequences

- The **real** engineering is server-side: the order-state store and the paid leg
  (PLAN-0007 T1/T2). Neither UI can tell the truth without them.
- Status is **polled** from the store; there is no client-side order state to lose.
- Facilitator console auth depends on Nostr key handling in a browser context
  (signing only; no key material at rest).
- The customer flow works with the customer's **existing** wallet — no onboarding
  wall, and no new wallet surface to secure.
- Revisit triggers: a demanded single-install "order + wallet" experience (then
  consider fork or an embedded `cashu-ts` slice), or a Play Store requirement
  (then Capacitor/TWA, not a rewrite).

## Alternatives considered

| Option | Verdict | Reason |
|---|---|---|
| Native Android app | rejected for v1, deferred | cost ≫ need; PWA push covers notifications; deferred wrap path available |
| Fork `cashubtc/cashu.me` | rejected | inverted IA, unmergeable diff vs active upstream, custody not needed |
| Standalone new PWA (new repo) | rejected | splits discovery from ordering; ADR-0005 already puts presentation on the registry client |
| Grow the registry dashboard into the client | **chosen** | discovery, catalog, deploy story all already exist there |
