/**
 * card_for_launcher.ts — one card read, printed once, for the assisted checkout.
 *
 * The launcher spawns this with `CVM_FIAT_CARD_ID` and reads stdout into memory.
 * Nothing is written to a file, argv, the environment of a child, or a log. The
 * helper exits non-zero rather than print partial values.
 *
 * This is deliberately a separate process: the 2fiat token lives in OpenBao and
 * the customer service (the `cvm` user) has no access; only the facilitator
 * launch path runs this.
 */
import { loadFiatSecret } from "../../fiat-cvm/secret.ts";
import { FiatClient } from "../../fiat-cvm/fiat_client.ts";

const cardId = (Deno.env.get("CVM_FIAT_CARD_ID") ?? "").trim();
if (!cardId) {
  console.error("card_for_launcher: CVM_FIAT_CARD_ID is required");
  Deno.exit(2);
}

const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 30_000 });
let details: { cardNumber?: string; cvv?: string; expirationDate?: string };
try {
  details = await client.requestCardDetails(cardId);
} catch (e) {
  // The message can contain a provider response; print the class only.
  console.error(`card_for_launcher: ${(e as Error)?.name ?? "error"}`);
  Deno.exit(3);
}

const pan = String(details.cardNumber ?? "");
const cvv = String(details.cvv ?? "");
const exp = String(details.expirationDate ?? "");
if (!pan || !cvv || !exp) {
  console.error("card_for_launcher: provider returned incomplete values");
  Deno.exit(4);
}

console.log(JSON.stringify({ pan, exp, cvc: cvv }));
