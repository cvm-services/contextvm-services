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
