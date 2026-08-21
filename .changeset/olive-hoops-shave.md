---
"@aburi/core": minor
"@aburi/cli": patch
---

Record a filename Aburi cannot build an id from, instead of ending the scan on it

`discoverFiles` called `toPosixRelative` outside any `try`. That constructor runs the **Symbol
id** path grammar, which refuses `:` and `#` — both legal POSIX filename characters, and `#`
legal on Windows and macOS too. One such file anywhere in the tree threw a `CoreError` naming the
id constructor, and the whole walk died with it. Six lines below, a file that cannot even be
`stat`ed is recorded on `skipped[]` and the walk continues.

Both are "one file cannot be handled". They now reach the user the same way:

```
⚠ 1 file(s) contributed no Symbols: unroutable=1
⚠ unroutable (1) — no route into the IR exists for them, decided before either was read. …
    src/od#d.ts: its name contains "#", which a Symbol id is split on, so nothing declared in it could be given an id
```

**The Document names it.** `stats.skippedFiles[].path` is held to the shared path rule
(integrity #10), which admits both characters — only the *id* grammar refuses them. So the file
is counted in `totalFiles`, excluded from `parsedFiles`, and listed by path, and everything built
for lost files answers honestly with no change: `aburi explain` says the IR never analysed it, and
`buildDiff` puts it in `notCompared[]` when both revisions lost it.

**Reason: `unroutable`, generalized.** Two producers, one meaning — *no route into the Document
exists for this file, decided before it was read.* The router refusing an extension and the id
grammar refusing a name are the same answer with different causes, and the skip `detail` says
which. A distinct `unnameable` would be the better model and is not available: `reason` is a
closed `enum` in `aburi.ir.v1.json` and, by `$ref`, in `aburi.diff.v1.json`, so a document
carrying a new value is rejected by any validating reader. Recorded as a v2 shape in
`ir-schema.md` §15.4 with that reasoning.

**`toDocumentPath` beside `toPosixRelative`.** The path rule and the id rule are now separate
entry points, because the two answers call for different responses. A path that is not
workspace-relative at all is a caller handing over something from outside what the Document
describes, and there is nothing to record — still fatal. A path that merely cannot host an id is
one file to skip, and the skip entry names it using exactly the rule that will accept it.
`symbolIdSeparatorsIn` answers the second question without an exception, and the id grammar
enforces the rule through the same helper so the two cannot drift.

**`aburi explain` stops claiming a `#` argument that is not an id.** `cli-spec.md` §7.2 has always
said the id arm applies to a string that "matches the `<language>:<path>#<qname>` form"; the
implementation took any `#` and answered "no such Symbol id" for it. That was invisible while no
`#`-named file could be in a document — and it would have made the file arm unreachable for
exactly the files this change adds. The id arm now claims the argument only when it is one, and
§7.2's file arm loses its "contains no `#`" clause, which the same change falsifies.
