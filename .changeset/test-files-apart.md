---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/markdown-projection": minor
"@aburi/cli": minor
"@aburi/github-action": minor
---

The changes of test code are reported apart, and a gate can leave them out. A new config field, `testFiles`, names the files that hold test code: glob patterns in the syntax of `ignore`, defaulting to `**/*.test.*`, `**/*.spec.*`, `**/*.test-d.*`, `**/*.spec-d.*`, `**/__tests__/**`, `**/__mocks__/**`, `**/__fixtures__/**`, `**/test/**`, `**/tests/**` and `**/e2e/**`; a list given replaces the default one, and `[]` marks no file. Those files are still scanned, so their calls stay in the dependency graph, and every Symbol of one carries `inTestFile: true` in the IR, an optional key no fingerprint reads.

`diff.md` lists the changes of those Symbols, by name and grouped as the sections above it, in a folded `## 🧪 Test files` section at the end, and in no other section; the Summary line ends `· N in test files`. The Slice View leaves out a Slice made of test code alone. A pair is placed by its head Symbol. On a pull request that only edits fixtures the report was a page of `➕ Added` entries for scratch variables; it is now the Summary line and one fold.

`aburi diff --fail-on-scope non-test` makes every `--fail-on` clause count only the changes outside test files, and the tripped line says so: `--fail-on removed tripped (observed: 1 removed outside test files)`. The default, `all`, counts every change as before. The line naming the removed duplicates a `removed` clause did not count reads the same scope. The GitHub Action forwards a new `fail-on-scope` input. For library users, `evaluateClause` and `evaluateFailOn` take the scope as an optional third argument, `FailOnScope` is a new export, and `TrippedClause` carries a required `scope`, which `formatTriggered` reads.

Compared with an IR scanned before this release, an IR scanned after it moves no Symbol, as no fingerprint reads the key. A removal is placed by its base Symbol, though, which the older IR does not mark, so a deleted fixture stays in `➖ Removed` and counts under `--fail-on-scope non-test`. `aburi diff <base>..<head>` scans both sides with this release, so neither happens there.
