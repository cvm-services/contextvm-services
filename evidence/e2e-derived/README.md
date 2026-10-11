# e2e evidence — five venues through the DERIVED client

Captured 2026-10-10 from this checkout, one filtered `restaurant-cvm` instance per
venue, over `wss://relay.primal.net`. `services/restaurant-cvm/e2e_client.ts` no
longer carries a per-venue table: its item counts and order baskets are derived
from `venues/<slug>/venue.json` (see `basketFor`/`deriveVenueCfg`). These
transcripts are the proof that the derivation is right for every venue in the
checkout — including the two that were previously hard-coded, which are re-run
here precisely because the derivation replaced their constants.

Reproduce (one filtered `restaurant-cvm` instance per venue, then the client):

```bash
# each venue's own key, never on a command line (see services/restaurant-cvm/run-venue-server.sh)
VENUE_SERVER_VENUES=<slug> VENUE_SERVER_KEY_FILE=$HOME/.hermes/secrets/venues/<slug>.nsec \
  services/restaurant-cvm/run-venue-server.sh          # one instance per venue
deno run --allow-net --allow-read --allow-env services/restaurant-cvm/e2e_client.ts \
  --server <that venue's announced pubkey hex> --relay wss://relay.primal.net \
  --venue <slug> --json > evidence/e2e-derived/<slug>.json
```

`e2e_client.ts` carries no per-venue table: its expected item count and its
expected menu content hash come from the COMMITTED anchor
(`venues/anchors.json`), which the client also checks the live reply against, so
a transcript whose record has drifted no longer reproduces. The transcripts below
were captured on 2026-10-10, before that anchor existed; their `total_items`
agree with it (they are the same records), but a fresh run now carries the
`sha256=…==…` field in the `tools/call:menu` check detail.

| venue | all_passed | menu | order |
| --- | --- | --- | --- |
| `chandi-berlin` | True | total_items=167 venues=["chandi-berlin"] expected=["chandi-berlin"]/167 | status=basket lines=2 total=18 venue=chandi-berlin deep_link=https://chandi-restaurant.com/menue/ |
| `doreedos-steakhaus-berlin` | True | total_items=150 venues=["doreedos-steakhaus-berlin"] expected=["doreedos-steakhaus-berlin"]/150 | status=basket lines=2 total=11.97 venue=doreedos-steakhaus-berlin deep_link=https://doreedos-steakhaus.de/kontakt |
| `la-mama-berlin` | True | total_items=104 venues=["la-mama-berlin"] expected=["la-mama-berlin"]/104 | status=basket lines=2 total=18.5 venue=la-mama-berlin deep_link=https://la-mama-steglitz.de/menu/ |
| `doppelt-kaese-berlin` | True | total_items=76 venues=["doppelt-kaese-berlin"] expected=["doppelt-kaese-berlin"]/76 | status=basket lines=2 total=15.8 venue=doppelt-kaese-berlin deep_link=https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase |
| `pizza-e-pasta-ruedesheimerplatz` | True | total_items=112 venues=["pizza-e-pasta-ruedesheimerplatz"] expected=["pizza-e-pasta-ruedesheimerplatz"]/112 | status=basket lines=2 total=17.1 venue=pizza-e-pasta-ruedesheimerplatz deep_link=https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway |

Each transcript also carries the full raw request/response event pair
(`transcript`), including the gift-wrap envelopes and the signed inner 25910
events, so the NIP-44 / NIP-59 wire shape can be re-checked from the file.

