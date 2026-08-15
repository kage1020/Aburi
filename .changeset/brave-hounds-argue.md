---
"@aburi/core": minor
"@aburi/cli": minor
---

Withdraw the file a plugin threw on, instead of the whole run

`lang-plugin.md` §7.2 has always said what should happen when extraction throws:

> - If `extractSymbols` / `walkBody` / `normalizeAst` throws → skip the entire file, warning log
> - The extraction pipeline as a whole does not stop (prevents one file's bug from halting all IR generation)

Neither `scan.ts` nor `pipeline.ts` contained a single `try`, so it never did. One throw
discarded every file's results and the run produced no IR at all:

```ts
// src/route.ts — an Auth.js route file, and legal TypeScript
export const { GET, POST } = handlers
```

The destructuring pattern's text reaches `makeSymbolId` as a qualified name, the id grammar
refuses it, and `scan()` exits non-zero having written nothing. A `src/ok.ts` beside it produces
nothing either; delete the one file and the same run succeeds.

## What happens instead

Any plugin call that throws for a file — `parseFile`, `extractSymbols`, `walkBody`,
`normalizeAst`, a framework `classifySymbol`, an effect `classify` — withdraws that file. The
run continues, and the file is accounted for twice:

- `ScanResult.skipped` gains `reason: "extraction-failed"`, so it is named in the list that
  answers "why is this file missing from the IR";
- `ScanResult.extractionFailures` is a new `{ file, message }[]` carrying what the plugin
  actually said, the way `parseTimeouts` carries numbers `skipped` has nowhere to put.

A file that could not be read at load time is `"unreadable"` — the reason discovery already uses
for the same condition — rather than an extraction failure.

Unlike a file abandoned for its `parseTimeoutMs` budget, a thrown file loses its recoverable
parse errors: the pipeline result never materialized. The thrown message stands in for them.

## One throw is still fatal

A `CoreError` with `code: "scan-plugin-misconfigured"` propagates. That code means the plugin
*set* is wrong rather than this file — an effect plugin returning a Promise from the synchronous
`classify`, a language plugin emitting Symbol ids with no language prefix — and both repeat for
every file, so absorbing them per file would report the workspace as broken instead of the
plugin.

Every other coded error describes the file and is absorbed: `anonymous-symbol-id-attempted` and
`invalid-symbol-id` come from what a declaration is named, `non-posix-path` from where it lives.

A plugin-wide bug outside that one code now presents as one failure per file rather than one
crash. That is the intended shape rather than a regression — every file is named, the messages
are identical, and the count is the whole workspace.

## `aburi scan` exits 3 when a file was dropped this way

Without this the change would be a loudness regression: a guard firing would go from "exit 1, no
output" to "exit 0, output written, a line on stderr". `cli-spec.md` §5.4 already assigns `3` to
a plugin error for `scan`, and a reviewer now gets both the partial IR *and* a non-zero code,
where a thrown guard previously gave them neither.

The scope is exactly `extractionFailures`. Over-size, unroutable and timed-out files keep exiting
`0` — whether they should gate, and behind what threshold, is a separate open question.

`ScanReport` gains `extractionFailures`, and the stderr block names the count on its own line so
a reader handed a non-zero status can tell which of the counts earned it.

## Contracts restated rather than changed

`effect-plugin.md` EP3a and the `plugin-input` guards said a contract violation "fails the scan".
It now fails the *file*. EP3a's reason for refusing to degrade — that a silently unclassified
call turns a parser bug into a quietly under-populated IR — is untouched by this: a withdrawn
file is counted, named, quoted back with the guard's own message, and reflected in the exit code.
Silence was the objection, and there is none here.

`SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch` over it.
