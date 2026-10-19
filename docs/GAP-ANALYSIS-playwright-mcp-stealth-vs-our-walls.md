# GAP ANALYSIS — "Playwright MCP / stealth / reverse-engineering" vs our measured walls

Date: 2026-10-19. Author: Felix (manager session).
Status: analysis of third-party advice (a German AI-mode answer) against OUR measured record.

**Method note.** The advice arrived as an AI-mode summary with citations. Per
`expert-consultation` Rule 3 ("never ask what we can verify ourselves") and Rule 9a
(a consultant can be flatly wrong on a checkable mechanic), every checkable claim
below was verified live before being adopted or rejected. **No consultant lanes were
dispatched: the quota gate returned exit 1 at 2026-10-19 21:xx**, so an LLM panel
would have burned API we do not have. The analysis is therefore grounded in our own
logged measurements plus three fresh probes run for this document.

---

## 1. The advice, in its own terms

| # | Claim | Our verdict |
|---|---|---|
| 1 | Use **reverse-engineered internal REST APIs** instead of UI clicking; Playwright's `APIRequestContext` is "many times faster and more stable" | **CORRECT, and already our architecture.** Independently validates the choice. |
| 2 | Make Playwright look human: `playwright-extra` + stealth plugin, `navigator.webdriver`, persistent profile, random delays | **PARTLY already done; NOT our blocker.** Our failures were never bot-detection. |
| 3 | Use **Playwright MCP** + accessibility tree instead of hard-coded click paths | **FALSE for this storefront — measured.** See §3. |
| 4 | Automate only up to checkout; keep payment **human-in-the-loop** | **CORRECT and already our design** (`submit: false`, `deep_link_human`). |
| 5 | Stream the browser into a PWA via noVNC / CDP screencast so the user can watch and intervene | **Genuinely new. Partly useful, partly risky.** See §5. |

---

## 2. Where our real walls were, and whether each idea touches them

Ten falsified assumptions are recorded in `RALPH-LOOP-finish-sats-ordering.md §0`.
Mapping the advice onto them:

| Our measured wall | Does idea 1 (API) fix it? | Idea 2 (stealth)? | Idea 3 (MCP/aria)? |
|---|---|---|---|
| **Location modal would not enable** — actual cause: **venue CLOSED** (opening hours) | n/a | no | no |
| **Radio checks but React won't re-render** — 6 interaction classes tried | n/a | no | no |
| **"Menü Anzeigen" disabled by CSS class**, not `disabled` attr | n/a | no | **yes** — `get_by_role("button", name=…)` found it, 1 match |
| **Add-controls indistinguishable** — 7 identical classed buttons, empty text | no | no | **NO — measured blind, see §3** |
| **Capri Sun row has no add control at all** | API would reveal it | no | no |
| **Vercel/github per-host IP blocks** | n/a | **no** — stealth is fingerprint, not egress | no |
| **Card fields in Stripe cross-origin iframes** | no | partly (fp) | no — iframe content not in main a11y tree |
| **Stripe may refuse automated browsers** | **YES — sidesteps it entirely** | partly | no |
| **Order-drafts 500 = missing field** | **YES — the only real fix** | no | no |
| **2fiat token was a URL not a token** | n/a | no | n/a |

**Reading of the table:** every wall we actually hit was a *protocol, state or
arithmetic* problem. **None was bot detection.** That is the single most important
gap between the advice and our evidence — the advice assumes we are losing a
fingerprinting fight; we were losing fights about opening hours, unlabelled DOM
controls, and an API contract.

---

## 3. The MCP / accessibility-tree claim — MEASURED, and it fails here

The advice's core promise: *"Anstatt dass eine KI 'blind' Screenshots analysiert …
nutzt Playwright MCP den strukturierten Accessibility Tree … Dadurch versteht eine KI
eine Seite wie ein echter Screenreader und kann Elemente extrem präzise anklicken."*

Probe (`/tmp/probe_a11y_add.py`, plain Python Playwright — the a11y layer is identical
to what MCP would consume, so no Node install was needed to test the claim):

```
venue radio via get_by_role("radio").first.check()   -> OK  (worked first try)
get_by_role("button", name="Menü Anzeigen")          -> 1 match  (CSS class-hidden name resolved)
get_by_role("radio", name="Three Buddies Steglitz")  -> 0 matches
buttons total                                        -> 165
add controls' accessible names                       -> "0" "0" "0" "0" "0" "0"
plus-like named controls                             -> NONE
unnamed buttons                                      -> 12
```

**Verdict: the accessibility tree is exactly as blind as CSS for the control we
could not click.** Every add button is announced as `"0"` (the quantity readout),
because the developer never gave them an `aria-label` or text. A screen-reader user
cannot add an item to this cart either — that is an accessibility defect in the
storefront, not a limitation of our tooling.

So MCP would have **inherited the same blindness** and cost more: Node 20+ is absent
on this host, plus one LLM round-trip per action versus a deterministic selector.

**Where the a11y approach IS a genuine improvement (adopt this part, cheaply):**
role/label-based locators beat CSS classes and beat drifting pixel coordinates for
*labelled* controls. Measured: `get_by_role("button", name="Menü Anzeigen")` resolves
a control whose only distinguishing feature is a CSS class, and `.check()` by role
worked where six prior interaction strategies had failed. **You do not need MCP to get
this** — `page.get_by_role(...)` is in the Playwright we already have. Cost: zero.

**Licence/facts verified:** `microsoft/playwright-mcp` is Apache-2.0, 38,363 stars,
last push 2026-10-16, npm `@playwright/mcp@0.0.83`. The advice is accurate on the
licensing; it is wrong on the capability claim for unlabelled controls.

---

## 4. The stealth claim — already done, and not the blocker

Already in our harnesses: `navigator.webdriver` undefined via `add_init_script`,
headed Chromium under `xvfb`, real desktop UA, `locale=de-DE`,
`timezone_id=Europe/Berlin`. **Not** done: `playwright-extra` + stealth plugin, and a
persistent profile.

Two honest notes:

1. A **persistent profile** (`launchPersistentContext`) is worth adopting for a
   different reason than stealth: our proven path requires re-doing the cookie banner,
   venue radio and schedule on every run. Persisting them removes ~40 s and one class
   of flake per attempt. That is a *reliability* win, not an evasion win.
2. Our two hard blocks today were **IP-level, per-host** (`ERR_CONNECTION_REFUSED`
   from the Vercel edge, then from `github.com:443`, while `api.github.com` and
   `example.com` answered in <200 ms). No amount of fingerprint stealth changes an
   egress-IP block. The fix is a different egress or a cooldown — which is what we did.

---

## 5. The PWA browser-streaming idea — the one genuinely new proposal

The advice suggests streaming the browser into a PWA via **noVNC** (Xvfb + x11vnc +
websockify + `<iframe>`), or **CDP `Page.startScreencast`** into a `<canvas>` with
click coordinates sent back over WebSocket.

**Why it fits our product:** our stage-1 design already declares
`deep_link_human` with the human holding payment authority. A streamed session is the
same idea with better UX — the facilitator sees the venue checkout, and when Stripe
demands 3DS or hCaptcha or a card, a human completes it *in the same session*.

**Why I recommend AGAINST it as the customer-facing default:**

- **ADR-0013 conflict.** The amended ADR permits card values only in the vault →
  just-in-time → the merchant/PSP being paid, never on our surfaces. A noVNC stream is
  a surface we operate: keystrokes cross our server. Drawing the boundary at
  "the human types into a streamed desktop we host" is materially weaker than "the
  human types into Stripe's own page in their own browser".
- **Cost and blast radius.** One desktop browser + VNC + WebSocket per concurrent
  order, for a protocol whose whole point is that sats settle asynchronously.
- **It does not remove the wall, it relocates it.** The streamed browser still has to
  *reach* the venue checkout, and today the storefront edge refuses our IP.

**Recommended use instead:** an **operator-side diagnostic**, not a customer surface.
We burned a day failing to see a page that a human would have read in two seconds
("Öffnet Dienstag 12:00"). A screencast-on-demand for the *facilitator* — behind auth,
no card entry — would have collapsed most of this investigation. That is a real win
and it is cheap: `Page.startScreencast` is already available in our Python Playwright.

---

## 6. Recommendation

**Adopt:**
1. **API-first stays the architecture** (validated by idea 1). Finish `POST /order-drafts`
   by capturing the real body — the missing-field 500 is an API-shape problem, and no
   browser technique fixes it.
2. **Role/label-based locators** in every harness, replacing CSS-class and pixel
   targeting where a control is labelled. Zero cost, strictly more robust (measured:
   `.check()` by role succeeded where six strategies failed).
3. **Persistent browser profile** for reliability (~40 s and one flake class per run),
   and for no other reason.
4. **Human-in-the-loop at payment** (validated independently by the advice).
5. **Operator-side screencast** for diagnosing walls like the closed-venue modal.

**Reject:**
6. **Playwright MCP for this problem.** Measured blind on the exact control we needed
   (all add buttons announced as `"0"`), needs Node 20+ (absent here), and adds an LLM
   round-trip per action to work we can script deterministically.
7. **noVNC as a customer payment surface** — ADR-0013 conflict, and it does not remove
   the reachability wall.
8. **More stealth work.** Our blocks were IP-level; our failures were state-level.

**Net:** the advice is *directionally right about the architecture we already chose*
and *wrong about the tool that was supposed to fix our specific wall*. Its most
valuable contribution is a diagnostic idea, not an automation idea.

---

## 7. What this changes in the plan

- `R2`: one technique swap — capture the draft body via the storefront's own JS
  (already located: `OrderManager.draftOrder` → `getOrderData: rr`), not via more
  Playwright variants. Role-based locators shorten the path to the cart.
- `R3b`: unchanged. `SPEND` is still `unmeasured`, and the €4.50 balance floor is an
  arithmetic gate, not a tooling gate.
- New, small: a `Page.startScreencast` diagnostic hook for future venue work.
