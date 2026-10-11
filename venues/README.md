# venues/

The venue catalog: one **PR-able directory per venue**, each produced by an
adapter that reads the venue's *own* API — never a hand-typed copy.

```
venues/<slug>/
  README.md          what the venue is, how to re-run, what was verified
  adapter.py         fetches + normalises the venue's public API -> venue.json
  venue.json         the canonical normalised record (generated, committed)
  evidence/          raw + rendered evidence the record was built from
    raw/             canonical copies of the API responses actually consumed
    fragments/       verbatim byte-slices of those responses (readable in the PR)
    PROVENANCE.md    URLs, sha256, retrieval date, redaction policy
```

## Rules

1. **One source of truth.** Every price, opening hour and item in `venue.json`
   comes from a field in `evidence/raw/`. Nothing is OCR'd, inferred or typed by
   hand. If a venue only publishes a menu as an image, say so and stop — do not
   invent prices.
2. **The record is generated, not edited.** `venue.json` is written by
   `adapter.py`. Hand-editing it produces drift that no client can detect
   (CEP-0001 §P3: content MUST come from the same source the venue serves).
3. **Idempotent.** A re-run against an unchanged source produces byte-identical
   output (`adapter.py --check` asserts this and prints the sha256). No
   timestamps, no unordered sets, no locale-dependent formatting in the output.
4. **Attribution, not cloning.** Images are referenced by source URL only. The
   venue's name, menu and prices stay the venue's; `venue.json.source.attribution`
   says so.
5. **No PII, no keys.** Committed evidence copies are passed through a documented
   redaction list (owner emails/phones, payment-platform keys, review authors).
   The sha256 of the *unredacted* response is recorded so provenance stays
   checkable by whoever is entitled to re-fetch it.

## Adding a venue

Copy the shape of `doppelt-kaese-berlin/`, point `CONFIG` at the new venue, and
verify with:

```bash
python3 venues/<slug>/adapter.py --fetch --selftest   # build + invariants
python3 venues/<slug>/adapter.py --check              # idempotence
```

Then commit the adapter, the evidence and the generated `venue.json` together.

## The verification anchor (`venues/anchors.json`)

A served catalogue must be checked against something that is **not derived from
`venue.json` at test time**, or every record passes. The first version of the
Steglitz onboarding did the opposite: the server test re-walked `venues/`, the
e2e client built its expected item count from the same records the server
served, and both compared their own arithmetic with itself. A fabricated
`venues/bogus-venue/venue.json` — no `evidence/`, no `adapter.py`, no source,
invented prices — was served and the suite stayed green
(`ok | 41 passed | 0 failed`).

`venues/anchors.json` is the committed expectation instead:

```
deno run --allow-read --allow-write venues/tools/menu_anchors.ts --write   # regenerate
deno run --allow-read               venues/tools/menu_anchors.ts --check   # verify
```

It carries, per served venue, the item count, the price bounds, the priced
fulfilment methods, the count of starting (`From`/`ab`) prices, the capture time
and a **sha256 over the venue's whole served projection**, plus one sha256 over
the whole catalogue. Regenerating it is an explicit command, so onboarding or
re-capturing a venue shows up as a diff to this file — the review gate. The
generator **refuses** to anchor a served venue with no committed evidence on
disk, so a hand-typed record cannot be made to pass by regenerating the anchor
either.

Three checks then hold, and no one of them can be satisfied by editing a record:

1. the anchor covers exactly the served venue set (tests and the e2e client);
2. the anchor matches the records on disk (drift guard — a record edit without a
   regeneration fails);
3. the **live served reply matches the anchor**, content hash included.

The one anchor that predates this and was already independent —
`capture_menu.py --check`, which rebuilds a class-1 menu from its committed
`evidence/raw/page.txt` — is now wired into the CI lane as
`deno task venues:check` (it also covers every venue at once with `--all`).

Adding a venue is still **data**: a `venue.json`, its evidence, and a
regeneration of this one file. No code file changes (ADR-0007 amendment).
