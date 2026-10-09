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
- 2fiat authorizes via a **6-digit email OTP**, so the operator's mail is in the loop unless a non-OTP rail is found.
- Charges are **device-initiated only**: with no server-side card reference, our backend cannot retry a card charge. If the device dies mid-payment, recovery is manual via the ADR-0012 Nostr DM escalation.
- Sats must be final before any fiat spend (ADR-0008) - the console must not reach the card step without a settled payment.
