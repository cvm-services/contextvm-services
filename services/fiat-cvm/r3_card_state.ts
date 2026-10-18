// R3 step 1 — MEASURE the 2fiat card state. Read-only, no money moves.
//
// ADR-0013 discipline: this prints card IDENTIFIERS, masked numbers and balances
// only. It never prints a PAN or CVV, and the token is never echoed.
//
// What we need to know before writing any funding code:
//   1. Which cards exist, and is each one fundable (has an id + a topup surface)?
//   2. What is the current balance (is it still the ~0.38 USD card)?
//   3. Does `can_authorize` say True/False — i.e. is the masked-PAN wall real
//      TODAY, or was that a stale reading?

import { FiatClient } from "./fiat_client.ts";
import { loadFiatSecret } from "./secret.ts";

const secret = await loadFiatSecret({});
console.log(`token source: ${secret.source} (len ${secret.token.length})`);

const client = new FiatClient({ token: secret.token, fetchImpl: fetch });

const cards = await client.cards();
console.log(`cards: ${cards.length}`);

for (const c of cards as Array<Record<string, unknown>>) {
  // Print only non-sensitive identity + state. No PAN, no CVV.
  const show: Record<string, unknown> = {};
  for (const k of ["id", "name", "currency", "balance", "available", "status", "can_authorize", "masked_number", "last4"]) {
    if (k in c) show[k] = c[k];
  }
  console.log(JSON.stringify(show));
}

// Report which keys exist, so we can see the real shape without dumping values.
if (cards.length > 0) {
  console.log(`\nfield names on card[0]: ${Object.keys(cards[0] as object).sort().join(", ")}`);
}
