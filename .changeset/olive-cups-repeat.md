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

The invocation is `git diff --find-renames --name-status -z` now. `-z` terminates every field
with NUL and turns the quoting off, so a path arrives as the bytes it is. The reader takes the
record length from the status — `R` and `C` name both ends of a move, every other status names
one path — and refuses the whole stream rather than returning a partial map when a field is not
a status where one must be: a desynced reader produces plausible pairs, and a wrong rename is
worse for the match than no rename hint at all. That refusal warns and degrades to no hints, the
same fallback a `git` that failed outright already got.

`defaultGitRunner` also decodes stdout once, from the joined bytes, instead of decoding each
chunk as it arrives. A multi-byte character that straddled two chunks came back as U+FFFD — on
exactly the long listings nobody reads by hand.
