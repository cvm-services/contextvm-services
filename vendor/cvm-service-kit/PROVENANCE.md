# vendored/cvm-service-kit — PROVENANCE

This directory is a **read-only, byte-verbatim copy** of the emitter from the
separate repo `cvm-services/cvm-service-kit`. It is vendored here so that the
nosms announcement can be emitted through the *shared* kit instead of a
hand-rolled tag list, **without** adding a network dependency on another repo's
unmerged branch, and so CI can prove the Python port is faithful.

The kit is the **source of truth** for the tag contract. Nothing in this
directory may be edited here — see "Do not fork it" below.

| Field | Value |
|---|---|
| Source repo | `https://github.com/cvm-services/cvm-service-kit` |
| Source branch | `pr/s2a-announce-emitter` (PR #1, OPEN) |
| Source commit | `7bf4be68a45e0a88b21f221852f3ef504b6a5807` |
| Copied on | 2026-10-05 |
| Files | `src/announce.ts`, `src/vocab.ts`, `src/validate.ts`, `src/mod.ts`, `vocab/service-inputs.json` |
| Register sha256 | `f21190037d264d891cb4fad12dcfa77516da290d89aa1989d36f75f8919b508b` |

`vocab/service-inputs.json` is byte-identical to this repo's own
`vocab/service-inputs.json` (both sha256
`f21190037d264d891cb4fad12dcfa77516da290d89aa1989d36f75f8919b508b`) — the
`contextvm-services` repo owns the register, the kit vendors it, and this repo
vendors the kit. One register, two copies, one hash.

## Regenerating this directory

```bash
cd ~/repos/cvm-service-kit && git rev-parse HEAD          # must match the table above
cp src/{announce,vocab,validate,mod}.ts \
   <contextvm-services>/vendor/cvm-service-kit/src/
cp vocab/service-inputs.json <contextvm-services>/vendor/cvm-service-kit/vocab/
sha256sum <contextvm-services>/{vendor/cvm-service-kit/vocab,vocab}/service-inputs.json
```

Re-vendoring is a deliberate commit that updates the commit sha in this table.
Never edit a vendored file in place: the whole point of the golden fixture is
that the vendored emitter and the Python port are compared against the same
bytes.

## Do not fork it

`cvm-service-kit` is the source of truth; a second, drifting implementation is
the failure mode `ADR-0001 D11`/`D14` exist to prevent. The Python port in
`nosms` is checked against the **golden fixture this directory generates**
(`fixtures/nosms-11316.tags.json`), and this repo's own `deno test` asserts the
vendored kit still reproduces that fixture. If the kit changes, the fixture is
regenerated *here* and the `nosms` port is updated to match — in one reviewed
commit, in one direction.
