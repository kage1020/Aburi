---
"@aburi/cli": minor
"@aburi/core": minor
"@aburi/types": minor
---

`stats.lspEnrichment` says how many receiver hints the typed tier produced, used, and threw away

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

Neither sum is checkable from the finished document, and §7.2 now says so rather than reading
like an integrity invariant: `requestsIssued` also carries a `documentSymbol` per file, so the
hover count the producer identity balances against is not an IR quantity, and the call sites that
found a hint at their key are recorded nowhere. The tests hold both sums instead.

The two halves are written by two passes, and the second cannot reach the first: the resolver
runs after `enrichWithLsp` has returned. `ResolveCallGraphResult` therefore carries a new
`lspHintUsage` — what the LSP tier consumed and what it declined — rather than the resolver being
handed a stats builder it would otherwise depend on having, and `withHintUsage` folds the two
together. `enrichWithLsp` returns the producer half as `LspProducerStats`, whose three counters
are required where the IR type has them optional, so a caller assembling the passes itself is
told by the type that `withHintUsage` is what finishes the record. Without that fold
`hintsConsumed` and the resolver's two buckets stay at `0`.

`aburi scan` prints the three totals when a run produced or refused a hint, so the question the
counters answer does not require reading the IR.
