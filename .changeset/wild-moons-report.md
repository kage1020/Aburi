---
"@aburi/core": minor
"@aburi/types": minor
---

Say how many receiver hints the typed tier produced, used, and threw away

`stats.lspEnrichment` counted requests and files and nothing about answers, so the one number a
reader reaches for — did turning LSP on buy anything? — was not in the document. A hover that
comes back on time carrying nothing this pass can read is a healthy row in every counter there
was: it lands in `requestsIssued`, in neither failure counter, it resets the consecutive-failure
tally, and its file still counts in `filesEnriched`. `requestsIssued: 40, requestsFailed: 0`
described a run that resolved forty extra call sites and a run that resolved none, and §6.2 keeps
errors out of the IR, so nothing else recorded the difference either.

Three counters now do. `hintsProduced` is the hovers read all the way to a callee Symbol,
`hintsConsumed` the call sites the resolver turned into an edge, and `hintsRejected` the five
places in between where a hint is lost — `unparseableHover`, `ownerClassNotFound`,
`memberNotFound` on the enrichment side, `kindMismatch` and `targetDropped` on the resolver's.
Two sums hold and neither crosses the halves: every hover that came back without a failure is
either produced or in one of the first three buckets, and every call site that found a hint at
its key is either consumed or in one of the last two. A hint the untyped tier made unnecessary is
in neither, which is the ordinary shape of a healthy scan rather than a fault.

The three are additive optional fields on `LspEnrichmentStats` in `aburi.ir.v1`, Class B per
`ir-schema.md` §1.1: the pipeline writes all of them whenever it writes the record, with
`hintsRejected` carrying five zeroes rather than being omitted, so absence means the document
predates the counters. A new `LspHintRejections` definition holds the buckets.
`resolveCallGraph` reports its half as `lspHintUsage` on its result rather than writing into a
builder it would otherwise have to be handed — it resolves whether or not the LSP pass ran — and
the scan pipeline folds the two together.

**Two behaviour changes came out of counting.** A receiver hint is keyed by `file:line`, and a
line can hold two receivers: `this.foo(super.foo())` is one line, two call sites, and one key.

The resolver now checks the hint's receiver kind against the one the call site writes. It did
not, so the call that lost the key took the survivor's hint and emitted a `high`-confidence edge
to a method no hover had attributed to it; it is left unresolved and counted in `kindMismatch`
instead. Only a line holding two different receivers can reach this — an ordinary `this.` call
site matches its own hint.

And which of two colliding jobs keeps the key is now decided by `(Symbol id, column)` rather than
by which hover answered first. The jobs run concurrently, so the survivor used to be a property
of server latency, and the resolution it produced was not reproducible across runs of the same
scan — a `lsp-enrichment.md` §10 violation that predates these counters and would have made them
unstable too.
