---
"@aburi/core": patch
---

Keep a throw inside LSP enrichment from ending the scan and stranding the server

`enrichWithLsp` called `processLanguage` with nothing around it, so anything thrown between
starting a language's server and shutting it down left that server running — a real
`typescript-language-server` child process with neither `shutdown` nor the SIGKILL behind it
ever reached. The same throw travelled out of the pass and ended the whole scan, over an
enrichment that is optional by design and whose every value has an untyped-tier one already
written underneath it.

`didOpen`, `didClose` and each request were individually guarded; the code that *applies* their
results was not. `applyDocumentSymbols` recursed over the server's `DocumentSymbol` tree without
a bound, and a tree deeper than the JavaScript call stack — a depth the server chooses — arrived
as `RangeError: Maximum call stack size exceeded` thrown out of the pass.

Both halves are closed. The language body now runs in a `try`/`catch`/`finally` that opens once
the server exists and before it is asked for anything: a throw is the per-language tier of §6.1
— warn once, disable the language, keep going — and the `finally` shuts the server down on every
exit, including the two that previously each had their own call. Whatever the language enriched
before the throw is kept, per §6.2. A `shutdown` that itself fails is now warned about rather
than silently swallowed; it means a server that may still be running, which is the whole thing
that call prevents.

`applyDocumentSymbols` walks an explicit stack instead of recursing, so the depth is the
server's to choose again. Children are pushed in reverse so the visit order is unchanged —
pre-order, parent before children, siblings in source order — because matching takes the first
entry at a given line and name, and the order decides which columns a Symbol gets.

`lsp-enrichment.md` §6.1 names the third per-language condition, and §6.3 gains the two rules
this rests on: the pass must not propagate an exception, and a started server must be shut down
exactly once on every exit.
