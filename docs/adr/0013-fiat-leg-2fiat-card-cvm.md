# ADR-0013 - The fiat leg is the 2fiat card CVM; card data stays on the facilitator's device

Status: Accepted 2026-10-09 (operator)

## Context
A facilitated order needs a fiat payment at the venue. Three candidate rails were weighed: hand off to the venue's own checkout (a restaurant exposes no card-not-present API, so this needs brittle, ban-prone page automation), run our own PSP (we would take the money and become merchant of record - a money-transmission question), or the 2fiat card CVM already chosen for card management in ADR-0007/0010.

## Decision
The fiat leg is the **2fiat card CVM**. It is the only option that pays a restaurant on the venue's own rail without us becoming a payment intermediary.

Card custody (operator decision, same date): **card data stays on the facilitator's device inside the PWA and is never transmitted to our servers.** Exposing it to the vendor/PSP being paid is acceptable. The PWA uses the PSP's publishable key with hosted card fields, or hands off to the venue's/PSP's own payment page; our order service receives only the payment result (payment-intent or transaction id) and verifies it server-side before transitioning the order. PAN/CVV must never reach our repos, logs, support DMs, or the Nostr bus.

A PSP 'token' in this document means a reference (e.g. `pm_1AbC...`) that stands for a card and cannot be reversed into the PAN without the PSP's secret key. Under this decision we may hold such a token for display/reuse, or hold only the transaction id.

## Consequences
- The card half of 2fiat is still unbuilt (the local adapter, t_63be63f1) and must be finished before a real venue payment.
- ~~2fiat authorizes via a **6-digit email OTP**, so the operator's mail is in the loop unless a non-OTP rail is found.~~
  **MEASURED FALSE 2026-10-18:** the OTP is API-retrievable (`GET prepaid-cards/details/{id}/otp`).
  The mailbox is not in the loop. See the 2026-10-18 amendment.
- ~~Charges are **device-initiated only**: with no server-side card reference, our backend cannot retry a card charge.~~
  **SUPERSEDED 2026-10-18:** measurement found *no* charge-by-reference endpoint at all
  (`POST prepaid-cards/pay` -> 404 `product_not_found`); 2fiat exposes card VALUES
  (`cardNumber`, `cvv`, `expirationDate`) or nothing. See the 2026-10-18 amendment, which
  permits holding values in OpenBao and automates the charge.
- Sats must be final before any fiat spend (ADR-0008) - the console must not reach the card step without a settled payment.

## Amendment 2026-10-18 (card values MAY be held by the vault so the card step can be automated)

**Operator decision.** The original custody rule was written on the assumption that 2fiat
would give us a card *reference* we could charge server-side. Measurement killed that
assumption, so the operator has decided to allow card **values** to be held in OpenBao and
used by our services, in order to automate the card step fully. This amendment records that
decision and the constraints that keep it as narrow as possible.

### What was measured (2026-10-18, $0 spent, no charge attempted)

| Probe | Result |
|---|---|
| `POST /api/v1/prepaid-cards/pay` | **404 `product_not_found`** — this route resolves a *card product to buy*, NOT a charge against an existing card |
| `POST /api/v1/prepaid-cards/details/{id}` | **200**, returns `cardNumber`, `cvv`, `expirationDate` |
| `GET  /api/v1/prepaid-cards/details/{id}/otp` | **200** — 3DS OTP is retrievable over the API |
| All `payments` / `transfers` / `payouts` / `withdrawals` routes | 404 |

**There is no charge-by-card-reference endpoint.** 2fiat exposes card *values* or nothing.
Therefore the original rule — "charges are device-initiated only, with no server-side card
reference" — described a world that does not exist. It is superseded, not merely amended.

Two further corrections, both measured:
- The 3DS stop is **not** an email/mailbox step. The OTP is API-retrievable
  (`GET .../details/{id}/otp`), so the operator's mailbox is **not** in the loop. The
  original "Consequences" bullet asserting this was wrong.
- The web UI genuinely surfaces `cvv` to the browser, confirming the platform's own model
  is "hand the values to the payer", not tokenisation.

### Decision

Card values **may** be held by OpenBao and used by our services so the card step can run
unattended. Specifically:

1. **At rest:** permitted in OpenBao only, under `secret/data/fleet/2fiat`, never in a repo,
   never in a config file, never in an environment file, never on argv.
2. **In use:** fetched **just-in-time** per charge, held **in process memory only**, and
   discarded after the attempt. No caching to disk, no swap-friendly long-lived copies, no
   logging — not even truncated or masked, and not on error paths.
3. **In transit:** only to the merchant/PSP **being paid**, which the original decision
   already permitted ("exposing it to the vendor/PSP being paid is acceptable").
4. **Never** over the Nostr bus, in console/DM output, in order records, or in telemetry.
5. **CVV is single-use.** It is read, used for one authorisation, and dropped. It is never
   persisted between attempts, because storing CVV is prohibited by PCI DSS 3.2 even for a
   vault — so the implementation treats CVV as *transient*, with only PAN and expiry
   (if any) eligible for at-rest storage.

### Recommended implementation (safest form that still fully automates)

**Preferred: do not store card values at all.** The 2fiat token already in OpenBao can fetch
`details/{id}` on demand, so the card values can be obtained **just-in-time into memory** for
the seconds they are needed. This achieves full automation with **zero card values at rest**,
and sidesteps the CVV-at-rest problem entirely. Storing them is the fallback, not the default.

- `2fiat-local-adapter` remains the **only** component that materialises card values, and it
  still never writes them anywhere.
- A server-side charge path, if built, must fetch-and-discard per attempt and must be the
  only place the values exist in memory.

### Consequences

- The "device-initiated only" and "operator's mail is in the loop" bullets above are
  **stale**; this amendment supersedes them.
- A charge retry is now *possible* in principle (values are retrievable), but retrying a card
  authorisation risks a double charge — the same hazard already documented for the sats rail.
  Treat a timeout as **outcome unknown** and reconcile by reading the card balance, never by
  retrying blindly.
- Risk accepted by the operator: a vault compromise now yields card values, not merely a
  reference. The blast radius is bounded by the provider's own top-up limit and by rotating
  the card, not by our storage.
- `2fiat-local-adapter` stays **private** (`tests/test_repo_visibility.py`), and
  `tests/test_no_token_material.py` must keep refusing committed card material.
