---
"@aburi/core": minor
"@aburi/cli": minor
"@aburi/types": patch
---

Withdraw a file its language plugin refused to parse

`ParseError.recoverable` has been documented since the plugin types were written:

```ts
/** false → core skips this file. */
recoverable: boolean
```

`lang-plugin.md` §7.1 said the same, in more detail: *"the file is skipped, excluded from
stats.parsedFiles, warning log"*. No non-test code in `packages/**` read the field — every
occurrence was a write. What actually withdrew a file was `ParseResult.tree === null`, a
separate signal a plugin sets independently.

So a plugin following the documented contract — return the tree you managed to build, mark
the error `recoverable: false` to say "do not use this file" — got its file extracted
normally. No error, no warning; the instruction was ignored.

`@aburi/lang-typescript` never noticed. The only `recoverable: false` it emits is paired
with a null tree, so the real gate fired anyway, and a plugin reasoning from the type
doc rather than from that coincidence got different behaviour from the one it asked for.

## What happens instead

The two signals are read as one condition. A file is withdrawn when its parse returned no
tree **or** reported any error marked non-recoverable:

- no Symbols reach the IR, and `extractSymbols` / `walkBody` / `normalizeAst` are never
  called for it;
- `ScanResult.skipped` gains an entry with `reason: "parse-failed"`, whose `detail` quotes
  the refusing error's message and position. With no tree and no such error it quotes the
  first recoverable one instead, because a withdrawn file is excluded from the CLI's
  recoverable-error count and this line is then the only place its errors can be read;
- `stats.parsedFiles` excludes it while `stats.totalFiles` still counts it;
- the core logs a warning.

Its **parse errors are still reported** on `ScanResult.parseErrors`, for the reason a
timed-out file keeps its own: they are diagnostic rather than IR, and here they are the
entire account of why the file went. Its **import edges are kept** — a file whose contents
could not be used still told us truthfully what it imports, the one place this differs from
a file abandoned on its `parseTimeoutMs` budget, which is being withdrawn deliberately.

Reading the flag also gives a plugin something it did not have: a way to reject a file it
*could* parse — a wrong-dialect source, a generated blob — without fabricating a null tree
to be heard.

## The two other halves of that sentence

The doc promised three things and the code delivered one, *including for the null-tree case
it did implement*: a file with no tree was excluded from `parsedFiles` and otherwise
invisible — no `skipped` entry, no warning. Both now happen for both conditions, so
`ScanResult.skipped` finally answers "why is this file missing from the IR" exhaustively.

That makes the count derivable from the list, so the counter beside it is gone. On the public
surface the identity is now `stats.parsedFiles = stats.totalFiles - ScanResult.skipped.length`:
one subtraction, where before a withdrawn file was both listed and counted and would have been
netted out twice, reporting two files lost for one.

What the length has to mean is *at most one entry per file*, which rests on every branch that
records a skip ending the file's turn in the loop.

`SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch`
over it. `ScanReport.skipped[].reason` is narrowed from `string` to that union, so the CLI
report now fails to compile if a member is renamed rather than silently reporting zero.

`ParseError.recoverable` is read as exactly `false`, not as a falsy value. Plugins arrive as
plain JavaScript through a `PluginRef`, and a plugin that simply omits the key would otherwise
have every file it reported any parse error on withdrawn, silently and at exit `0`. Read
literally, such a plugin is left where it was before the field was read at all.

## The CLI stopped calling a refusal recoverable

`⚠ N file(s) had recoverable parse errors.` counted every file on `ScanResult.parseErrors`,
which now includes files withdrawn *for an error that said it was not recoverable*. The
counts are split:

```
⚠ 3 file(s) had recoverable parse errors.
⚠ 1 file(s) could not be parsed and were left out of the IR.
```

`ScanReport.parseErrorCount` counts files whose errors the plugin called recoverable; the new
`ScanReport.parseFailureCount` counts the ones it refused. The split is by what the plugin
said rather than by what reached the IR — a file abandoned on its `parseTimeoutMs` budget is
counted on the first line and is not in the document, because its errors really are all
recoverable and they are the reason that path keeps them.

`aburi scan` stays at exit `0`. An unparseable file is a property of the source, like an
over-size or timed-out one; `extraction-failed` remains the only reason that gates
(cli-spec.md §5.4). The same row promised exit `1` on a "cascade of unrecoverable parse
errors", which nothing implemented and which this change contradicts outright; it now
describes the read failures that really do end the run.
