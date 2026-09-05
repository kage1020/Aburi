---
"@aburi/core": patch
---

A receiver hint is spent on the call it was produced for

`makeReceiverHintKey` keyed an LSP receiver hint by file and line, while
`makeCallSiteKey` — the key for the other side channel of the same call sites —
deliberately carries the target too, because "line alone collides in
`a().b(c().d())`". For a hint channel that collision is not a near-miss.

**A hint applied to a line applied to every call on it.** `this.charge()` beside
`sendPaymentToBank()` resolved the second call to `Svc.charge`: an edge no source
line justifies, a `Dependency` the reader cannot find in the file, and one fewer
entry in the `unresolved` diagnostics that would have shown the mistake. The
fabricated edge reached `propagateEffects` like any other, so the effects
attributed to the caller were wrong in the same direction — an external function
contributing whatever the class method touches.

**And when both calls on the line were `this.*`, the hint that survived was
whichever hover answered last.** `this.foo(this.baz())` resolved `this.foo` to
`C.baz` against a fast server and to `C.foo` against a slow one — the same input,
the same server configuration, different `calls[].resolved` and different
`dependencies[]`. The module docstring claimed LSP arrival order never affects
output; the jobs it credited for that were not sorted, and sorting alone would
not have helped while the last write won.

Hints are now filed and read under `makeCallSiteKey(file, line, target)` — one
key function for both channels, so they cannot drift apart again — and
`resolveViaLspHint` additionally checks the hint's `kind` against the receiver
its call names, which is the check that holds for a `receiverHints` map a caller
assembled by hand. Every response for a file is held until all of its jobs have
stopped and applied in job order (Symbol id, then call line, then target), so
what a file produces is decided by the sort and not by the server's pace, and the
first hint for a call site wins. A file's responses are still applied on the way
out of a thrown job, so a per-language fallback keeps what it had already earned.

`makeReceiverHintKey` and the `ReceiverHintKey` type are gone from the public API;
`makeCallSiteKey`, now exported from its own module, replaces both. A caller
building `receiverHints` by hand must key with it — a map keyed the old way
resolves nothing rather than resolving the wrong thing.
