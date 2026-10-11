# venues/chandi-berlin

**Chandi Restaurant** — Albrechtstraße 52, 12167 Berlin-Steglitz. A class-1 venue (ADR-0007): the venue takes the
order from a person, so the CVM hands over the basket and the venue's own page
and places nothing.

```json
"adapter": { "class": "deep_link_human",
             "capabilities": { "menu": true, "quote": true, "submit": false, "status": false } }
```

## Captured

| | |
|---|---|
| source | <https://chandi-restaurant.com/wp-content/uploads/2025/06/menue_2025.pdf> — the venue's own published menu PDF |
| extractor | `pdf_text` |
| captured_at | `2026-10-10T08:05:05+00:00` |
| items listed / priced | 167 / 167 |
| sections | 25: Suppen, Vorspeisen, Salate, Vegetarische Gerichte, Hühnerfleischgerichte, Lammgerichte, Nordindische Spezialitäten, Südindische Spezialitäten, Grillspezialitäten, MENÜVARIATIONEN, Gerichte Für Kinder, Beilagen, Dessert, Aperitif, Heiße Getränke, Teespezialitäten, Flaschenbiere, Säfte, Spirituosen, Rum & Tequila, Weinbrand & Cognac, AMERICAN, SCOTCH, Liköre & Bitter, Prosecco & Champagner |
| price range | 0.5 – 95.0 EUR |
| lines the declared patterns did not match | 401 (reported, never guessed into the record) |
| lines quarantined (a name that swallowed a second price) | 22 |
| http status / bytes / sha256 of the response | 200 / 805222 / `95cb31fcf00a4848fe01d79b126d169617fb75113de459c0a5237ff8b9891cf9` |

The venue's telephone number (+49 30 98412763, from the telephone number printed in the venue's own Impressum (2026-10-10)) is the hand-off
contact; it is not copied into the evidence (`evidence/raw/` is redacted, see
`redactions_applied` in `evidence/raw/source.json`).

## Re-running

No per-venue code exists for this venue — it is configuration plus one shared
tool:

```bash
python3 venues/tools/capture_menu.py --venue venues/chandi-berlin/venue.json --fetch   # re-capture
python3 venues/tools/capture_menu.py --venue venues/chandi-berlin/venue.json --check   # idempotence
```

`--fetch` re-reads the venue's own page, rewrites `evidence/raw/page.txt`,
`evidence/raw/source.json` and `evidence/fragments/`, then rebuilds the `menu`
block. Nothing in `venue.json` is hand-typed: every item and price below is a
line of the venue's own page that matched the patterns declared in
`venue.json.capture`.

## What was verified

- `python3 venues/tools/capture_menu.py --venue venues/chandi-berlin/venue.json --check`
  → `CHECK OK chandi-berlin` (the committed `menu` block is byte-identical to a rebuild
  from the committed evidence).
- `deno test -A services/restaurant-cvm/` → the venue is served with its adapter
  contract and its `captured_at`; the suite passes.
- No price, item or opening hour was typed by hand and none is OCR'd.
