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
| items listed / priced | 104 / 104 |
| sections | 10: Salate, Überbackene Gerichte, Pizza, Pasta - SPAGHETTI, Pasta - TORTELLINI, Pasta - RIGATONI, Pasta - TAGLIATELLE BANDNUDELN, Burger & Menüs, Hähnchen, Drinks |
| price range | 1.5 – 10.5 EUR |
| lines the declared patterns did not match | 113 (reported, never guessed into the record) |
| lines quarantined (a name that swallowed a second price) | 0 |
| http status / bytes / sha256 of the response | 200 / 190089 / `5cd8a76c272e420a3e6ca3acba4b4247149a862b5293f64bbb3102a4bb92533f` |

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
