/**
 * LIVE end-to-end of the FIXED `topup` tool: token -> cards -> invoice -> BOLT11.
 * Creates a real top-up invoice (UNPAID: costs nothing, expires in 90 min) and
 * prints the BOLT11 truncated -- it is a payment REQUEST, not a credential, but
 * there is no reason to paste a payable string into a transcript.
 */
import { loadFiatSecret } from "./secret.ts";
import { FiatClient } from "./fiat_client.ts";
import { topupFiat } from "./topup.ts";

const secret = await loadFiatSecret();
const client = new FiatClient({ token: secret.token, timeoutMs: 25000 });
const r = await topupFiat(client, { amount: 2 });

console.log(JSON.stringify({
  kind: r.kind,
  cardId: r.cardId.slice(0, 8) + "…",
  chargedAmount: r.chargedAmount,
  subtotal: r.subtotal,
  fee: r.fee,
  bolt11_present: Boolean(r.bolt11),
  bolt11_len: r.bolt11.length,
  bolt11_prefix: r.bolt11.slice(0, 12) + "…",
  bolt11_valid_shape: /^lnbc[0-9]/i.test(r.bolt11),
  feeDiscrepancy: r.feeDiscrepancy ?? null,
  note: r.note,
}, null, 2));
