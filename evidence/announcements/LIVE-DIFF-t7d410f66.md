# LIVE before/after — what the announced relays actually served

Readbacks: `live-before-t7d410f66/` (fetched before the republish in this run) and `live-after-t7d410f66/` (after). Both relays (`wss://relay2.orangesync.tech`, `wss://relay.primal.net`) returned the same single event per (venue, kind).

## doppelt-kaese-berlin — kind 11316

- before: id `12ee1fdbc200243c891932b6e9751d21948ae126e13088aee2ab7504532beb34` created_at 1791586660
- after:  id `12ee1fdbc200243c891932b6e9751d21948ae126e13088aee2ab7504532beb34` created_at 1791586660
- event replaced by this card: **no**
- the relay already served this content before the republish in THIS run (the fix for this venue/kind had already been published earlier in the same card — see `published-t7d410f66/` and the note below), so there is no live-vs-live diff to show.

## doppelt-kaese-berlin — kind 11317

- before: id `7b6a4010412b2765af09c9df7f0248702d8dc358f7571a9989be0b171d5148e1` created_at 1791406630
- after:  id `7b6a4010412b2765af09c9df7f0248702d8dc358f7571a9989be0b171d5148e1` created_at 1791406630
- event replaced by this card: **no**
- the relay already served this content before the republish in THIS run (the fix for this venue/kind had already been published earlier in the same card — see `published-t7d410f66/` and the note below), so there is no live-vs-live diff to show.

## pizza-e-pasta-ruedesheimerplatz — kind 11316

- before: id `a41f4e5c596a90372ac0f3447ab2ac7c2499163b263fdb18832a9a568524e294` created_at 1791406675
- after:  id `d58b21fbc10232a84d816de953aad31d608051b66776679eeb14a39bfb116d39` created_at 1791588772
- event replaced by this card: **yes**
- tags added: `[]`; removed: `[]`

```diff
--- before
+++ after
@@ -7,9 +7,12 @@
   "currency": "EUR",
   "fulfilment": {
     "delivery": {
+      "area_mode": null,
       "areas_named": null,
       "areas_note": "deliveryMode=PostCode: the platform resolves deliverability from the customer's address/postcode server-side (/oyy-api/MyRestaurant/restaurant/<id>/delivery-area, the route name found in the frontend bundle). No postcode list or radius is exposed in the public payload, so none is asserted here.",
-      "available": true
+      "areas_retracted": null,
+      "available": true,
+      "zones": null
     },
     "method_condition": "ship.address is required for a DELIVERY order only; a PICKUP order needs no address (the venue's own page asks for the address when delivery is chosen).",
     "methods": [
```

## pizza-e-pasta-ruedesheimerplatz — kind 11317

- before: id `ace6d6ec802c5a080352698a8d01774b66c710427964b510151cb2bdfd0cf1f1` created_at 1791406720
- after:  id `ace6d6ec802c5a080352698a8d01774b66c710427964b510151cb2bdfd0cf1f1` created_at 1791406720
- event replaced by this card: **no**
- the relay already served this content before the republish in THIS run (the fix for this venue/kind had already been published earlier in the same card — see `published-t7d410f66/` and the note below), so there is no live-vs-live diff to show.

