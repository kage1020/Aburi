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
entry at a given line and name, and the order decides which columns a Symbol gets. The shape is
the server's to choose too: a `children` that is `null` rather than absent reads as no children,
the way the recursion's `?? []` did.

`runJobsWithConcurrency` no longer settles on the first rejection. `Promise.all` cancelled
nothing, so the surviving workers went on calling a client that had been shut down and writing
into Symbols the pass had already returned — which is the determinism guarantee in §10.6, not
untidiness. Workers now record their failures instead of rejecting, every worker is awaited, and
the lowest-indexed failure is rethrown. Running the remaining jobs rather than abandoning them
keeps the set of writes a failing file produces the same on a rerun.

`safeShutdown` is bounded. It was the only client call in the pass without a deadline, awaited
from a `finally`, so an injected client whose `shutdown` never settled stopped the scan with
nothing to read. A hang now reports the same "it may still be running" line a failure does.

`lsp-enrichment.md` §6.2 gains the rule the retention rests on — columns already written when a
fallback fires are kept, which is not what "remain `null`" says — and §6.1 cites it. §6.3 names
the third per-language condition's rules: the pass must not propagate an exception, a started
server must be shut down exactly once on every exit, a shutdown warning is not counted by rule
3, and the pass must not write to the Document after it has returned.
