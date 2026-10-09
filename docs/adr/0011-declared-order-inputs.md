# ADR-0011 — Order inputs are declared once and rendered from that declaration

- **Status:** **Accepted 2026-10-09** — operator requirement ("it should be an input to the contextvm
  if it's required. Expose such input fields in the UI using a framework like ...").
- **Date:** 2026-10-09
- **Decided:** every order input (fulfilment, delivery address, contact phone, basket) is declared in
  the service-inputs register and the customer UI is rendered **from that declaration**. Hand-built
  per-field forms are rejected.
- **Tier:** docs/light
- **Depends on:** ADR-0004 (`order.fulfilment` required, `ship.address` conditional), ADR-0010
  (amendment: contact phone is a per-order input), `docs/spec/service-inputs.md`.

## Context

The venue announcements already declare required fields (`cvm:req:order.fulfilment`, and previously a
wrongly-unconditional `cvm:req:ship.address`). The venue CVM already validates a basket and refuses a
missing delivery address loudly. What is missing is the *other half of the same fact*: a UI that reads
the declaration instead of hard-coding a form, and a contact phone that is an input rather than an
assumption about who owns a number.

Three concretely-required inputs exist today: `order.fulfilment`, `ship.address` (when delivery) and
`order.contact.phone` (when the venue's rail requires a callback).

## Decision

1. **One declaration, one source.** The service-inputs register is the single place an input is
   declared: name, type, required-when condition, and how it is shown.
2. **The customer UI renders fields from that declaration.** Adding an input means editing the
   declaration, not the form. A field that the register does not declare cannot appear in the UI.
3. **The venue CVM enforces the declaration server-side.** A required-but-missing input is a loud
   refusal, never a defaulted value - the contact number in particular must never be substituted.
4. **On the choice of library.** The named options were vetted rather than adopted from a pasted
   summary (which is how three of five names survived contact):
   - **JSON Forms** (`jsonforms.io`) - real, established, JSON-Schema-driven forms. This is the
     boring correct default if a library is used at all.
   - **A2UI** (`a2ui.org`) - real protocol, ~22 implementations on GitHub; relevant only if we ever
     want an agent to drive the UI, not for rendering a three-field order form.
   - **OpenUI** - real, but the canonical project is `wandb/openui` (22.6k stars), and it is
     "describe UI in natural language", **not** the token-efficiency/DSL framing in the pasted text.
     The "67% fewer tokens" claim was not verified.
   - **"JSON Render (Vercel Labs)"** - **could not be verified**: `github.com/vercel/json-render`
     is 404 and a GitHub search for `json-render in:name user:vercel` returns **0** repositories.
     Treat as unconfirmed until a real source exists.
   - **"JsonUI"** as a state-decoupled framework - **not verified**; the GitHub hits for that name are
     a CLI JSON explorer and an XIB converter. Do not adopt on this evidence.
5. **Decision on the merits, not on the list:** for a form of three to six declared fields the
   requirement is met by rendering the register with a schema-driven form; no framework is adopted
   unless a concrete gap appears. If one is adopted, it is JSON Forms.

## Consequences

- Adding a required input (the contact phone today) is a declaration change plus a test, not a UI
  rewrite - and it cannot silently diverge between server validation and the rendered form.
- The pasted-framework summary is recorded as **partly wrong**; the operator's rule to vet pasted AI
  sources held."
