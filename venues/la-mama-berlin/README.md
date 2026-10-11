# venues/la-mama-berlin

**Pizzeria La Mama Steglitz** — Albrechtstraße 119, 12167 Berlin-Steglitz. A class-1 venue (ADR-0007): the venue takes the
order from a person, so the CVM hands over the basket and the venue's own page
and places nothing.

```json
"adapter": { "class": "deep_link_human",
             "capabilities": { "menu": true, "quote": true, "submit": false, "status": false } }
```

## Captured

| | |
|---|---|
| source | <https://la-mama-steglitz.de/menu/> — the venue's own Speisekarte page |
| extractor | `html_block_text` |
| captured_at | `2026-10-10T08:05:08+00:00` |
| items listed / priced | 104 / 104 — of which **44 are the venue's own "From" starting prices** (see below) |
| sections | 10: Salate, Überbackene Gerichte, Pizza, Pasta - SPAGHETTI, Pasta - TORTELLINI, Pasta - RIGATONI, Pasta - TAGLIATELLE BANDNUDELN, Burger & Menüs, Hähnchen, Drinks |
| price range | 1.5 – 10.5 EUR (starting-price items from 1.8) |
| lines the declared patterns did not match | 113 (reported, never guessed into the record) |
| lines quarantined (a name that swallowed a second price) | 0 |
| http status / bytes / sha256 of the response | 200 / 190089 / `5cd8a76c272e420a3e6ca3acba4b4247149a862b5293f64bbb3102a4bb92533f` |

## "From" prices are starting prices, not prices

44 of the 104 items are printed on the page as

```
30. PIZZA MARGHERITA
From
6 EUR
```

`6 EUR` is what that pizza starts at. The capture used to declare
`skip_lines: ["From"]`, which **deleted the venue's own qualifier**, and
`venue.json` then carried `"price": 6.0` with nothing to say it is a floor — and
a customer's sats price is derived from this catalogue. la-mama is priced for
`pickup` (`service_method_note`: the venue's own card is priced for collection),
i.e. the venue the operator runs a real money test with, so a floor quoted as an
exact price is the facilitator's own money.

The qualifier is now parsed (`capture.from_price_lines: ["From"]`) and recorded:
every such item carries

```json
"price_is_from": true,
"price_qualifier": "From"
```

and `menu.price_semantics` (mirrored in `menu.stats.from_priced_items`) states
`44 of 104 listed items carry the venue's own starting-price qualifier`. The
served `menu`/`order` replies and the published kind-11316 announcement all carry
the same fact — an `order` total containing one of these lines is returned with
`total_is_lower_bound: true`. See `venues/tools/capture_menu.py` (the
`from_price_lines` block) and `services/restaurant-cvm/price_semantics_test.ts`
(which re-derives the qualified pairs from `evidence/raw/page.txt` and fails if
any of them is presented as exact).

A cheaper alternative — dropping the 44 items from the orderable set — was
rejected: they are real, orderable items, and hiding them would lose the biggest
section of the card. Flagging them keeps them orderable and keeps the number
honest.

The venue's telephone number (+49 30 70760100, from the telephone number printed on the venue's own contact page (2026-10-10)) is the hand-off
contact; it is not copied into the evidence (`evidence/raw/` is redacted, see
`redactions_applied` in `evidence/raw/source.json`).

## Re-running

No per-venue code exists for this venue — it is configuration plus one shared
tool:

```bash
python3 venues/tools/capture_menu.py --venue venues/la-mama-berlin/venue.json --fetch   # re-capture
python3 venues/tools/capture_menu.py --venue venues/la-mama-berlin/venue.json --check   # idempotence
```

`--fetch` re-reads the venue's own page, rewrites `evidence/raw/page.txt`,
`evidence/raw/source.json` and `evidence/fragments/`, then rebuilds the `menu`
block. Nothing in `venue.json` is hand-typed: every item and price below is a
line of the venue's own page that matched the patterns declared in
`venue.json.capture`.

## What was verified

- `python3 venues/tools/capture_menu.py --venue venues/la-mama-berlin/venue.json --check`
  → `CHECK OK la-mama-berlin` (the committed `menu` block is byte-identical to a rebuild
  from the committed evidence).
- `deno test -A services/restaurant-cvm/` → the venue is served with its adapter
  contract and its `captured_at`; the suite passes.
- No price, item or opening hour was typed by hand and none is OCR'd.
