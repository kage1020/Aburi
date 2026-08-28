---
"@aburi/types": minor
"@aburi/lang-typescript": minor
"@aburi/core": patch
---

Free the parse tree the language plugin hands over

A WASM parse tree is not something the JavaScript garbage collector can reach. `lang-plugin.md`
§8.1 says so and names the consequence — `RangeError: WebAssembly.Memory()` after some thousands
of files — but told the plugin to free a tree it had already given away, and nobody on the other
side picked it up. `@aburi/core` contained no `delete` call at all, so every file that parsed
successfully left its tree in the WASM heap for the rest of the run.

`LanguagePlugin` gains an optional `releaseTree(tree)`. `runFilePipeline` calls it once per
non-null tree, in a `finally` that covers every way out of the file: the success path, a file
withdrawn by a `recoverable: false` error, a file abandoned on `parseTimeoutMs`, and a throw out
of `extractSymbols`, `walkBody` or `normalizeAst`. A plugin whose trees are ordinary
garbage-collected objects omits the method and nothing changes for it.

The core is the only side that can do this. `parseFile` gives the handle away at step 1 and the
tree stays live until `normalizeAst` has read the last node out of it — a plugin that deleted
its own tree on the way out would be handing back something already dead. The one place the
plugin still frees it is a `parseFile` that fails *after* parsing, where the caller never
receives the handle.

A release that throws is warned about and dropped rather than propagated. It runs in a
`finally`, so a throw there would silently become the file's outcome — replacing the diagnostic
a failing file was already carrying, and turning a file that produced a perfectly good set of
Symbols into an extraction failure.

`@aburi/lang-typescript` implements it as `tree.delete()`.
