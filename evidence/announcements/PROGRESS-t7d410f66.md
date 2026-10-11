# PROGRESS — t_7d410f66 (resume map)

Run 3 (this run) started from the state left by run 1 (crashed, SIGTERM ~28 min).

- run 1 (crashed): committed `be46767` (doppelt area re-derivation), `bec628d`
  (pizza per-field provenance), `4db1484` (emitter + before/after diff doc),
  published doppelt 11316 (`12ee1fdb…`), then hung in `publish()` and was killed.
- run 3 (this run):
  1. oriented: read live relays -> doppelt 11316 already fixed; pizza 11316 still
     old; both 11317 already current. `live-before-t7d410f66/` (`fetch-live-announcements.sh`).
  2. `regen-check.sh` -> all four committed artifacts == fresh `--dry-run`. ok
  3. republished pizza 11316 with pizza's own key (`publish-pizza-11316.sh`) ->
     `d58b21fbc10232a84d816de953aad31d608051b66776679eeb14a39bfb116d39`, both relays OK.
  4. read back after -> `live-after-t7d410f66/`, `VERIFY.txt`, `TABLE.md`. all four
     live == emitter, both relays. exit 0.
  5. re-checked the rails: doppelt 200 + sha256 match; pizza 403 (plain + cookies).
  6. independent circle-vs-district recompute: 11 of 15 outside. matches retraction.
  7. found + fixed the hang: `tools/nostr.ts` closes its socket on every exit path;
     RED first (`tools/nostr_publish_test.ts`, `RED-publish-socket-hang.txt`),
     GREEN, CLI exit proof `emit-exit-proof.txt` (exit_code 0, 11.2 s).
  8. `deno task test` 82/0/1 ignored; `deno task test:net` 83/0 (`test-net.txt`).
  9. wrote `EVIDENCE-t7d410f66.md` + `REPORT-t7d410f66.md`.

## State

- Working tree: commits + push are the only remaining steps at the time of writing.
- Nothing is left running: no background process, no republish pending.
- If a future run resumes: check `live-after-t7d410f66/TABLE.md` first; if the ids
  still match the table, the announcements are still correct and nothing needs
  republishing. `recheck_rail.py` re-verifies doppelt's rail cheaply; pizza will
  keep 403ing until the Cloudflare challenge is solved (browser session needed).
