# Vendored CEP-6 announcement emitter (read-only)

These files are a **verbatim copy** of the emitter surface from the
`cvm-service-kit` repo, taken because that repo's own PR is not yet merged and
this repo needs the emitter to build venue announcements (card S4a). They are
**never hand-edited here** — the kit is the source of truth; this is a pinned
snapshot for the glue.

| field | value |
| --- | --- |
| source repo | `cvm-services/cvm-service-kit` |
| source branch | `pr/s2a-announce-emitter` |
| source commit | `7bf4be68a45e0a88b21f221852f3ef504b6a5807` |
| copied on | 2026-10-05 |

## Files (verbatim, sha256 of the copy as vendored)

| path here | sha256 |
| --- | --- |
| `src/announce.ts` | `725d5629e05decf70feca33139bd2139e57522bdb506fc97062dd91c738bc511` |
| `src/vocab.ts` | `53cc46fc5d659ebff752808aad781318e5a151f5306db9351e2e1e358f000f1e` |
| `src/validate.ts` | `2eaa76655bcb403ba010fe43f527e04d26eed5d411d89292e30066677733521e` |
| `src/mod.ts` | `6bf6794d242da003708f2629dc743599f6a487dbb6fcaf5bb8c47d5f13656b47` |
| `vocab/service-inputs.json` | `f21190037d264d891cb4fad12dcfa77516da290d89aa1989d36f75f8919b508b` |

`vocab/service-inputs.json` is the **same blob** the kit vendored (its own
`vocab/PROVENANCE.md` records sha256 `f21190037d…`), which is in turn a verbatim
copy of `vocab/service-inputs.json` in `contextvm-services` @
`3f93093edde8f76c202bbeac30e1a7211133ccee`. So the kit and this repo enforce one
register.

The emitter's one hard rule is preserved here unchanged: **the caller cannot
supply the tier** — `emitAnnouncementTags` recomputes `cvm:tier:<max>` from the
declared fields. See the source headers in `src/announce.ts` for the full
contract.
