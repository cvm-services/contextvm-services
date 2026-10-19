import { loadFiatSecret } from './secret.ts';
import { FiatClient } from './fiat_client.ts';
const s = await loadFiatSecret();
const c = new FiatClient({ token: s.token, timeoutMs: 30000 });
const cs = await c.cards();
console.log(JSON.stringify(cs.map(x=>({id:x.id.slice(0,8), masked:x.masked_number, bal:x.balance}))));
