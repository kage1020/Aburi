---
"@aburi/cli": patch
---

Read git's rename table as NUL-separated records, so a path with a space or a non-ASCII
character still matches

`git diff --name-status` is tab-separated and this split its output on `/\s+/`, so
`R094\tsrc/a.ts\tsrc/a b.ts` produced the pair `src/a.ts -> src/a`. A path outside printable
ASCII was worse: git double-quotes and octal-escapes it under `core.quotePath`, and nothing
decoded that, so `src/日本語.ts` arrived as `"src/\346\227\245..."`. Either way stage 2 of the
match had a rename map that matched no Symbol's `source.file`, the move degraded into the
`removed` + `added` pair the stage exists to prevent, and a `--fail-on removed` gate turned a
build red for a file somebody had only renamed.

The invocation is `git diff --find-renames --name-status -z` now; `diff-algorithm.md` §3.2
carries the contract. Three things the reader now gets right that it did not:

- Paths arrive unquoted and undivided, because `-z` NUL-terminates every field and bypasses
  git's path quoting entirely.
- They are normalized to NFC, the form `sym.source.file` is compared in. A repository holding a
  path decomposed built a map that could not match anything — the same failure, on the same
  class of path.
- A stream whose records cannot be delimited is refused outright, position reported, rather than
  yielding the part that parsed. That now includes a stream cut inside a field, which used to map
  a rename onto a chopped path.

`collectRenames` also stopped discarding git's stderr. Over `diff.renameLimit` git exits 0, says
on stderr that it gave up, and reports every move as a delete plus an add: the records parse, the
map is merely empty, and the run that loses every hint is the large refactor where the hints
matter most. Any stderr from the rename invocation is now warned about, quoting git.

`defaultGitRunner` decodes stdout once, from the joined bytes, instead of decoding each chunk as
it arrives — a multi-byte character straddling a chunk boundary came back as U+FFFD — and a git
killed by a signal is now reported as such rather than as "exited with code null".
