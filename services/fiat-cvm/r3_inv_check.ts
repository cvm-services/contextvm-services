import { loadFiatSecret } from './secret.ts';
import { FiatClient } from './fiat_client.ts';
import { topupFiat } from './topup.ts';
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 30000 });
const r = await topupFiat(c, { amount: 2, card_id: '1ca031655b5d4c74a35e090b7979f7df' });
// decode the human-readable amount prefix: lnbc<amount><multiplier>1...
const m = r.bolt11.match(/^lnbc([0-9]+)([munp]?)/i);
const num = m ? Number(m[1]) : null;
const mult = m ? (m[2] || '') : '';
let msat = null;
if (num !== null) {
  if (mult === 'm') msat = num * 100_000_000;
  else if (mult === 'u') msat = num * 100_000;
  else if (mult === 'n') msat = num * 100;
  else if (mult === 'p') msat = num / 10;
  else msat = num * 100_000_000_000;
}
console.log(JSON.stringify({ charged_usd: r.chargedAmount, hrp: r.bolt11.slice(0,16), num, mult, sats: msat!==null?Math.round(msat/1000):null }));
