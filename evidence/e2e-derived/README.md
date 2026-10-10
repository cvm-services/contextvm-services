# e2e evidence — five venues through the DERIVED client

Captured 2026-10-10 from this checkout, one filtered `restaurant-cvm` instance per
venue, over `wss://relay.primal.net`. `services/restaurant-cvm/e2e_client.ts` no
longer carries a per-venue table: its item counts and order baskets are derived
from `venues/<slug>/venue.json` (see `basketFor`/`deriveVenueCfg`). These
transcripts are the proof that the derivation is right for every venue in the
checkout — including the two that were previously hard-coded, which are re-run
here precisely because the derivation replaced their constants.

Reproduce: `bash e2e-run.sh` (the three Steglitz venues) and
`bash e2e-run-legacy.sh` (the two pre-existing venues), each with the venue's own
`VENUE_SERVER_KEY_FILE` instance running; see the task log for the exact commands.

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

