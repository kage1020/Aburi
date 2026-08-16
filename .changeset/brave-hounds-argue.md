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
- `ScanResult.extractionFailures` is a new `{ file, message, code? }[]` carrying what the plugin
  actually said, the way `parseTimeouts` carries numbers `skipped` has nowhere to put. The CLI
  lists the first ten on stderr with the file and the message, capped so a plugin that rejects
  every file cannot scroll the rest of a CI log away.

A file that is *gone* by the time the scan reads it — discovery lists the workspace up front, and
a concurrent build can delete a listed path before the loop reaches it — is skipped as
`"unreadable"`, the reason discovery already uses for the same condition, rather than ending the
run as it did before. **Every other read failure still ends the run**: a permission the checkout
got wrong, an exhausted descriptor table, failing storage. Those depend on how the machine was
feeling, and absorbing them would let one commit produce a different Document on a different day
and still exit 0, which is the opposite of what a byte-stable canonical document is for.

Unlike a file abandoned for its `parseTimeoutMs` budget, a thrown file loses its recoverable
parse errors: the pipeline result never materialized. The thrown message stands in for them.

## Some throws are still fatal

An error whose code names a fault in the plugin *set* rather than in the file propagates and ends
the run:

- `scan-plugin-misconfigured` — an effect plugin returning a Promise from the synchronous
  `classify`, a language plugin emitting Symbol ids with no language prefix at all;
- `invalid-language-id` — the prefix is present but is not a legal `LanguageId`, which comes from
  the plugin's own `languageId` and so is the same on every Symbol it emits;
- `vocab-undeclared` — an effect or extKind id the emitting plugin's manifest does not claim.

Each repeats for every file, so absorbing them would report the workspace as broken instead of
the plugin, and would replace one precise sentence about the manifest with a file count.

Everything else describes the file and is absorbed: `anonymous-symbol-id-attempted` and
`invalid-symbol-id` come from what a declaration is named, `non-posix-path` from where it lives.
The check reads the error's `code` rather than its class, because `vocab-undeclared` is a
`RegistryError` and `@aburi/core` does not depend on `@aburi/plugin-registry`.

A plugin-wide bug carrying none of those codes now presents as one failure per file rather than
one crash. That is the intended shape rather than a regression — every file named, the messages
identical, the count the whole workspace — though it is a weaker diagnostic than a code that says
outright what is wrong.

`ScanResult.extractionFailures[].code` carries the thrown error's own code where it had one, so a
consumer can separate "this source is something the plugins cannot express" from "a plugin
crashed" without matching on prose.

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

## Two things this makes visible rather than fixes

A withdrawn file leaves no trace **inside** the IR. `skipped` and `extractionFailures` are
siblings of `ir`, not part of it, so `out/aburi.ir.json` records only that `parsedFiles` is below
`totalFiles` — the same gap an over-size file leaves. A `diff` against a healthy baseline
therefore reports the withdrawn file's Symbols as `removed`, and `--fail-on removed` trips with
the wrong explanation. Before this change there was no IR to be misled by; now there is a
complete-looking partial one, and the exit code is the only signal, which does not travel with
the artifact. The other withdrawal reasons have the same hole and have had it all along.
Tracked separately.

`export const { GET, POST } = handlers` — an ordinary Auth.js route file — is a reachable trigger,
so a repository containing one now exits 3 on every scan where it previously exited 1. The gate is
reporting a real loss rather than causing one, and the remedy is the id-grammar bug behind it
rather than this boundary.
