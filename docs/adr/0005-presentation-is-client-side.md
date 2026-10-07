# ADR-0005 — Presentation is client-side: catalog-constrained rendering of ContextVM services

- **Status:** **Accepted 2026-10-07** — operator sign-off recorded under *Decisions*.
  The Phase-0 spike is being built in `cvm-registry` alongside this ADR; nothing
  here changes the announced schema.
- **Date:** 2026-10-07
- **Decided:** presentation stays a **client** concern. A dashboard renders a
  service through a **catalog of components it defines**, and a render spec may
  only reference that catalog. **Venues never author layout, and never author
  prices.**
- **Tier:** docs/light
- **Depends on:** ADR-0001 (`D5` = the venue's own rail settles in v1),
  ADR-0004 (Cashu-before-bolt11; the `order` tool is a basket builder, not a
  checkout), `docs/spec/service-inputs.md` (the field register).

## Context

The question that produced this ADR: *can we shape the ContextVM spec so that
dashboards like `cvm.orangesync.tech` render our services with a JSON-UI framework
(e.g. [json-render](https://github.com/vercel-labs/json-render), Vercel Labs,
Apache-2.0, 18.5k★)?*

Three facts about the current state bound the answer:

1. **The dashboard is a 424-line build-less static site** (`site/index.html` +
   `site/app.js` + `style.css`), and it renders a *catalog of announcements*, not
   services: filters, trust/status pills, a review block, a facts list. It has
   **no menu view and no interaction at all**.
2. **The interaction surface is exactly two tools**: `menu` (optional
   `venue_slug`) and `order` (basket lines identified by `sku` or `id`; "Build a
   basket for the venue's own ordering rail. Checkout and payment happen on the
   venue's own page; this tool does not place or settle the order"). Discovery
   works; a machine still cannot buy dinner (ADR-0004).
3. **The relay budget is already tight.** strfry's default `maxEventSize = 65536`
   already refuses our own menu announcements (doppelt `66045` B, pizza `76965` B
   as measured 2026-10-06). Anything we add to an announcement competes with the
   data for that budget.

What json-render actually offers, read from its README rather than its tagline: a
**catalog** (components with Zod-validated props, plus named actions) that a model
or server emits JSON against — "AI can only use components in your catalog". The
spec is flat JSON (root key + elements map), so it is serializable, and
`@json-render/mcp` is explicitly *"MCP Apps integration for Claude, ChatGPT,
Cursor, VS Code"*. It is a rendering library. **It is not a sandbox.**

## Decision

### D1 — The announcement carries data and tools. Never presentation.

A CEP-6 announcement stays a statement of fact: identity, classes, requirements,
methods, prices, settlement. Adding a UI field would make the *venue* the author of
*our* dashboard's surface, and would create a second place a price can be stated.

### D2 — A dashboard renders through a catalog it defines.

The client owns the component set and the action set. A spec may only reference
catalog entries; props are validated; **an unknown component or action is ignored,
fail-closed** (the same rule D-165 applies to unknown tier names).

### D3 — Catalog actions map 1:1 to declared CVM tools.

An action may render only if the service actually declares the tool behind it.
`order` renders only where `order` exists; an action with no corresponding declared
tool MUST NOT be drawn — a button that cannot do anything is a lie about the
appetite.

### D4 — One source of truth for price.

Every number shown comes from the served `prices_by_method` / menu payload. A spec
may *select* and *format* a price; it may never *state* one. This is
"declared schema = served schema" applied to rendering (and the direct lesson of
72/76 doppelt items being cheaper on pickup while a single headline price).

### D5 — No code, no URLs, no HTML in specs.

Specs are data. No `innerHTML` from spec values, no spec-authored URLs, no
scripts. Bounded size (a spec must fit comfortably inside the relay budget it is
transported in), and a version field so a client can refuse a spec it does not
understand.

### D6 — v1 interaction limit: basket + hand-off.

The dashboard may show a menu, build a basket and produce a deep-link / `order`
payload. It **MUST NOT** present a payment step it cannot settle (ADR-0001 `D5`,
ADR-0004). The `bitcoin-lightning-bolt11` claim rule is the precedent: never
render an acceptance the venue has not confirmed.

### D7 — Adopt the spec *shape* now; the renderer is replaceable.

The Phase-0 spike implements a json-render-compatible flat spec (root + elements
map) with a ~150-line vanilla renderer, because the dashboard has no bundler.
Moving to `@json-render/react` — or exposing the catalog over
`@json-render/mcp` so Claude/ChatGPT/Cursor render our services natively — is then
a **renderer swap, not a rewrite**. A venue that genuinely needs a custom UI gets a
**napplet (NIP-5D)**, which has a real isolation boundary, rather than a spec
executed inside our DOM.

## Consequences

- No new field in the announcement, no schema migration, no relay-budget risk.
- The dashboard gains interaction (menu → basket → venue hand-off) without taking
  on the liability of a payment surface.
- The catalog becomes the review surface: adding a component or an action is a
  deliberate client change with a diff, not something a venue can push.
- Cost: personalized/"generative" views are bounded by our catalog, so the UI can
  be less bespoke than a venue might want. That is the trade we are choosing.
- `@json-render/mcp` gives external MCP hosts a path to render our CVMs; that is
  interop we get nearly free because our CVMs are already MCP servers.

## Open questions

1. Do we publish the **catalog** (component + action names and prop schemas) as an
   artifact, so third-party dashboards can render our services compatibly? (This is
   a client-side contract, not an announcement field — allowed under D2.)
2. Does the venue-consent gate for Track B (merchant of record, ADR-0004) need to
   extend to *any* action rendered on our surface, or only settlement ones?
3. Accessibility: the catalog must ship a11y-correct primitives, since venue
   variation can no longer be blamed for a bad tab order.

## Decisions

- **2026-10-07 — operator:** chose **NOW** for this track: write this ADR *and* run
  the Phase-0 spike in the same session. Phase-0 = one real venue (doppelt, 76
  items), a small catalog, every action mapped 1:1 to a real CVM tool, verified in
  a headless browser. No announcement change.
