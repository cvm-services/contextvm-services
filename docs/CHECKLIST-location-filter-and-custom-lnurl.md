# CHECKLIST — location filtering and custom LNURL

Tracking for [`PLAN-location-filter-and-custom-lnurl.md`](PLAN-location-filter-and-custom-lnurl.md).

Legend: `[ ]` todo · `[x]` done · `[~]` needs operator.

## A. Venue location data

- [x] A1. Normalize `address`/`location` from venue records into `site/menu.json`.
- [x] A2. Existing six Berlin venues have real coordinates and address labels.
- [x] A3. Missing coordinates are explicitly “unknown”, never “nearby”.
- [x] A4. No venue coordinates are invented.

## B. Customer filter UX

- [x] B1. Explicit **Use my location** button; no automatic permission prompt.
- [x] B2. Geolocation success/denied/unsupported states.
- [x] B3. City preset / manual coordinate fallback.
- [x] B4. Radius selector 5/10/25/50/100/all, default 10 km.
- [x] B5. Haversine filter, nearest-first, clear “straight-line” label.
- [x] B6. Show count and an empty state with a larger-radius option.
- [x] B7. Search still works with the location filter.
- [x] B8. Precise coordinates not persisted or sent to the backend/Nostr/logs.

## C. Custom LNURL rail

- [x] C1. Operator-only `LNURLP_PAY_URL`; customer cannot supply a recipient.
- [x] C2. HTTPS/callback/amount validation and no arbitrary private endpoint.
- [x] C3. LNURL-pay `callback?amount` creates a BOLT11.
- [x] C4. Payment hash extraction and LUD-21 verify polling.
- [x] C5. No proof ⇒ remains awaiting payment; no browser self-confirmation.
- [x] C6. Existing Cashu mint rail remains the default and tested.

## D. Poznań manual venue

- [x] D1. Verify a direct-order URL (candidate: Pizza Express i Burgery od 2001 r.).
- [~] D2. Verify Visa acceptance/fulfilment with the restaurant before a paid test.
- [x] D3. Capture real menu/prices/address/coordinates with attribution.
- [x] D4. Add `deep_link_human` venue record; no card credentials.
- [x] D5. No-charge rehearsal in Poznań radius; inspect the direct order page.
- [ ] D6. **Operator:** live Visa test only with a new dedicated order and the facilitator's own phone verification.

## E. Tests / publication

- [x] E1. cvm-registry PWA tests and JS syntax.
- [x] E2. cvm-orders Deno tests for the LNURL rail.
- [x] E3. Menu generator/enrichment test.
- [x] E4. Deploy static PWA and restart cvm-orders on the test host.
- [x] E5. Verify no secrets or precise location data in public artifacts.
- [x] E6. Keep the trust root local-only with no remotes.
