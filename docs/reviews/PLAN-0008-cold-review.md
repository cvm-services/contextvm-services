# Cold review — PLAN-0008 (venue account creation + login, ADR-0009)

- **Subject:** `docs/plans/PLAN-0008-venue-account-login.md`, as committed at `c1dd817`.
- **Reviewer model (router-served, authoritative):** `deepseek-v4.1-flash`
  (requested as `deepseek/deepseek-v4-flash`; the router served `deepseek-v4.1-flash`).
  Family **deepseek** — a different family from the plan's author lane (zai/glm), so this
  satisfies the cross-family requirement.
- **Captured:** 2026-10-10 02:38 CEST. One completion, 7 808 completion tokens
  (6 140 reasoning), prompt 4 377 tokens. No truncation; a `VERDICT:` line was present
  (the run only wrote the artifact because a verdict line existed).
- **Prompt given:** the plan was compressed to its decisions D1–D10, tests T1–T6 and criteria
  A1–A7 and inlined, with the ADR-0009/0013 constraints and a list of six specific attacks.
  The reviewer saw the plan text, not the repository — its `COULD NOT VERIFY` section is
  therefore load-bearing and is reproduced unedited below.
- **What was NOT done:** the flat router was `locked=true` on its weekly window (100 %) at the
  time and every other family 503'd (glm-5.3/5.2/4.5-*, kimi-k3/kimi-k3:cloud/kimi-k2.7-code,
  minimax-m3:cloud). One family answered; this is a single-reviewer verdict, not a two-family
  panel. That limitation is the reviewer-pool skill's documented partial-panel case.
- **Machine-readable verdict:** `VERDICT: APPROVE-WITH-CHANGES`

---

## Reviewer response (verbatim)

1. **VERDICT: APPROVE-WITH-CHANGES** — the custody split (secret in a local adapter, nothing in the public CVM) is the right shape, but the plan's own security claim about non-owner triggering, its ban/cooldown conflation, and its A2/A3 evidence gate are wrong or unsupported as written.

2. **BLOCKING FINDINGS**

**B1. A non-owner caller can trigger a login, contradicting D2.2/D9.**
(a) D2.2 and D9 claim a non-owner "can never cause a login," but `order` is a public tool and D4 routes session handling through the order path ("before any order touches the rail"). T3 only inspects *response shape*, not side effects.
(b) A4 ("non-owner cannot obtain account material") is met, but the stronger claim — non-owner cannot *cause* account activity (login attempts → Cloudflare lockout, ban) — is untested and likely false.
(c) Gate the account-triggering path on `assertOwner` at the point of `ensureSession`/`create`, and add a test that a non-owner `order` call never opens the local socket.

**B2. Cloudflare cooldown is misclassified as a ban.**
(a) D4 says "stale + login rejected → blocked," and D5 treats "login refused while the stored login is known to be valid" as a ban signal. Behind a managed challenge you cannot distinguish "wrong password" from "challenge blocked the POST."
(b) A transient cooldown fires the D5 ban path → ADR-0012 loss path + operator escalation for a temporary condition. This is the plan's own "measured, high" risk.
(c) Add a distinct `challenge_blocked`/`rate_limited` state; only escalate the loss path on a positive ban signal (explicit deactivation message, or account page missing the account *while authenticated*).

**B3. Ambiguous submit can double-cost, and the idempotency claim is unsupported.**
(a) D5 claims "a duplicate order is prevented by the existing idempotency key," but the plan also says "no retry" on blocked. If the order was submitted and the response was lost (403 challenge), the CVM marks `account_blocked`, escalates the loss path, and the venue fulfills the order.
(b) The idempotency key only prevents a *retry* from re-submitting; it does nothing when there is no retry. Operator pays the loss path *and* the fulfilled order.
(c) Define a reconciliation step (query the venue by idempotency key) before declaring the loss path.

**B4. A2/A3 may be unachievable, with no contingency.**
(a) The plan's own risk register rates Cloudflare cooldown "measured, high," and the task context says the challenge refused three attempts this week. A2 (real account created) and A3 (real login observed) are hard gates.
(b) The plan cannot meet its own acceptance criteria if the challenge blocks during the review window.
(c) Define acceptable evidence if the challenge blocks (timestamped attempt log + deferred successful run), or explicitly defer A2/A3 with a named owner and date.

**B5. Per-venue opt-in is asserted, not proven.**
(a) T1 only checks "Class 1 behaviour unchanged," which is trivially true if the CVM never reads `venue.json.account`. T2 only checks the announcement tag set.
(b) Neither proves the CVM gates the account flow on `account.enabled`; A6 is unmet.
(c) Add a test that the CVM refuses to trigger the account flow for a venue whose `account` block is absent/disabled, and specify where in `server.ts` the gate is enforced.

**B6. The alias in the public repo contradicts D2.3.**
(a) D6 says record "which alias" in the venue record; D8.2 documents "who holds the account" in the README. The alias is half the credential and is PII. D2.3 says "no account material in any durable artifact."
(b) A4/A5 are undermined by a self-inflicted leak of the account identifier.
(c) Keep the alias out of the public repo; reference it by an opaque `account_ref` only.

3. **NON-BLOCKING FINDINGS**

**N1.** `account_ref` is returned to the CVM (D9) but D6 says "the CVM side holds nothing — not … the alias." If `account_ref` is derived from the account, it is a stable handle. Define it as a random per-install id.

**N2.** T3's "secret-shaped" is undefined; a pattern grep proves absence of known patterns, not absence of secrets. Add a positive control (inject a known secret, assert the test fails).

**N3.** T6 tests the redactor, not that the session value never reaches the builder. Add a test that the session value is never passed to any response builder.

**N4.** D4 has no transition for "re-login succeeded but preflight still stale." Define it (`blocked` or `unknown`).

**N5.** D4's one re-login attempt has no cooldown wait; attempting during a Cloudflare cooldown extends it. Add a minimum wait derived from the measured cooldown.

**N6.** §1 claims ordering "requires an account" from an `Anmeldung` entry point; that only proves login exists. Open question 5 is unresolved and may make the capability unnecessary for pickup.

**N7.** `credential_owner` npub in `venue.json` may leak into the announcement if the announcement is derived from `venue.json`. T2's "byte-identical" would catch it, but the plan doesn't state the announcement source.

**N8.** `recon-auth-flow.py` lives in the public repo and drives the authenticated profile; the plan bans logs but doesn't forbid the script from logging values. Add an explicit no-value-logging constraint.

**N9.** No account-deletion/revocation path on the venue side; D8.2 only deletes local state.

4. **WHAT I COULD NOT VERIFY**
- Line count of `server.ts` (877) and "no auth code of any kind."
- Existence/content of `evidence/PROVENANCE.md`, `evidence/rendered-ordering-page.txt:3`, `evidence/auth-recon.json`, `docs/spec/service-inputs.md`, `docs/INDEX.md`, and the ADR-0007/0008/0009/0012/0013 texts.
- Whether the announcement is derived from `venue.json`.
- Whether the `cvm-2fiat` `assertOwner` precedent exists and its shape.
- Whether the persistent browser profile actually retains Cloudflare clearance across visits (the sibling card only proves `cf_clearance` transplant fails).
- Whether pickup is account-free at this venue.
- Whether `doppelt-kaese-berlin` is currently untouched.

5. **THE ONE THING MOST LIKELY TO SINK THIS**
The Cloudflare managed challenge. A2/A3 require live evidence on a rail that has already refused three attempts this week and whose cooldown the plan itself rates "measured, high." The session design (persistent profile) is the right shape, but if the challenge blocks during the review window, the plan cannot meet its own acceptance criteria — and the D4/D5 logic will misclassify the block as a ban, firing the ADR-0012 loss path on a temporary condition. Unachievable evidence plus a misclassification that costs money is the failure mode.

VERDICT: APPROVE-WITH-CHANGES

---

## Repo-side answers to the reviewer's `COULD NOT VERIFY` list

Checked after the review landed, so the record closes rather than repeats them:

| Reviewer's open item | Answer, and where it is checkable |
|---|---|
| `server.ts` is 877 lines with no auth code | `wc -l services/restaurant-cvm/server.ts` = 877; `TOOL_DEFS` at line 226 holds exactly `menu` and `order`; a read of the whole file found no session/cookie/credential code. Reproduce by grep: no `cf_clearance`, no `cookie`, no `session`, no `password` in that file. |
| `evidence/PROVENANCE.md`, `rendered-ordering-page.txt`, `docs/spec/service-inputs.md`, `docs/INDEX.md` exist | all four are in the tree; `PROVENANCE.md` is the measured Cloudflare record (including the "touch the origin ONCE" finding and the hashes). |
| Is the announcement derived from `venue.json`? | yes — `tools/venue_to_announcement.ts` maps `venue.json` → `AnnounceInput`, and `venue_announcement_test.ts` asserts the emitted tag set. This makes N7 a real risk, not a hypothetical: an `account` block that escaped into the mapping would land on the wire. T2 is the right guard and must stay. |
| Does the `cvm-2fiat` `assertOwner` precedent exist? | yes, in the sibling service `services/cvm-2fiat/src/tools.ts` (referenced by ADR-0012's operator identity). |
| Does the persistent profile retain Cloudflare clearance across visits? | **no, not reliably on this host this week** — see the addendum below. This is what makes B4 concrete. |
| Is pickup account-free at this venue? | **still unresolved.** The recon could not reach the page (challenge), so open question 5 stays open and `required_for` must not be asserted as `["delivery"]` until it is answered. |
| Is `doppelt-kaese-berlin` untouched? | yes — the diff of this branch touches no file under `venues/doppelt-kaese-berlin/`. |

## Addendum — the evidence gate, measured (B4)

`venues/pizza-e-pasta-ruedesheimerplatz/evidence/recon-auth-flow.py` ran one headed session on the
existing persistent profile (the same profile that returned HTTP 200 on 2026-10-05). Three
navigations, each waiting out the challenge for ~180 s:

| attempt | status | title | waited |
|---|---|---|---|
| 1 | 403 | `Nur einen Moment…` | 182.5 s |
| 2 | 403 | `Nur einen Moment…` | 176.8 s |
| 3 | 403 | `Nur einen Moment…` | 177.4 s |

Raw record: `evidence/auth-recon.json`. The profile's own cookie DB still holds a `cf_clearance`
dated to expire 2027-10-10 and a `__cf_bm` that expired 2026-10-10 00:46 — i.e. the clearance is
present but the challenge platform is re-issuing it on every navigation. This is the measured
condition B4 describes, and it is why A2/A3 are deferred rather than claimed.
