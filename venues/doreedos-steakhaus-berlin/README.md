# venues/doreedos-steakhaus-berlin

**Doreedos Steakhaus** — Lepsiusstraße 45, 12163 Berlin-Steglitz. A class-1 venue (ADR-0007): the venue takes the
order from a person, so the CVM hands over the basket and the venue's own page
and places nothing.

```json
"adapter": { "class": "deep_link_human",
             "capabilities": { "menu": true, "quote": true, "submit": false, "status": false } }
```

## Captured

| | |
|---|---|
| source | <https://doreedos-steakhaus.de/speisekarte> — the venue's own Speisekarte page |
| extractor | `html_block_text` |
| captured_at | `2026-10-10T08:05:06+00:00` |
| items listed / priced | 150 / 150 |
| sections | 15: Suppen, Vorspeisen, Salate, Pasta, Steaks vom Grill, Beilagen, Saucen, Medaillons vom Schwein, Fisch, Pizza, Spezialitäten des Hauses, Doreedos Spezialitäten, Fajitas, Kinder-Menü, Desserts |
| price range | 0.8 – 39.99 EUR |
| lines the declared patterns did not match | 99 (reported, never guessed into the record) |
| lines quarantined (a name that swallowed a second price) | 0 |
| http status / bytes / sha256 of the response | 200 / 237300 / `e14b6696a78a2235b73064955b643f0697900209bbff6369196a9122bb102883` |

The venue's telephone number (+49 30 89782250, from the telephone number printed on the venue's own Kontakt page (2026-10-10)) is the hand-off
contact; it is not copied into the evidence (`evidence/raw/` is redacted, see
`redactions_applied` in `evidence/raw/source.json`).

## Re-running

No per-venue code exists for this venue — it is configuration plus one shared
tool:

```bash
python3 venues/tools/capture_menu.py --venue venues/doreedos-steakhaus-berlin/venue.json --fetch   # re-capture
python3 venues/tools/capture_menu.py --venue venues/doreedos-steakhaus-berlin/venue.json --check   # idempotence
```

`--fetch` re-reads the venue's own page, rewrites `evidence/raw/page.txt`,
`evidence/raw/source.json` and `evidence/fragments/`, then rebuilds the `menu`
block. Nothing in `venue.json` is hand-typed: every item and price below is a
line of the venue's own page that matched the patterns declared in
`venue.json.capture`.

## What was verified

- `python3 venues/tools/capture_menu.py --venue venues/doreedos-steakhaus-berlin/venue.json --check`
  → `CHECK OK doreedos-steakhaus-berlin` (the committed `menu` block is byte-identical to a rebuild
  from the committed evidence).
- `deno test -A services/restaurant-cvm/` → the venue is served with its adapter
  contract and its `captured_at`; the suite passes.
- No price, item or opening hour was typed by hand and none is OCR'd.
