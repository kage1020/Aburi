---
"@aburi/core": patch
---

Make the effect-propagation sweep order sub-quadratic

`reverseTopoOrder` re-sorted the ready set on every dequeue and shifted off its front. Both
are linear in the size of that set, and the set is large in the ordinary case: most symbols
call nothing, so nearly every SCC is ready from the start and the set grows to the size of
the graph. That put the pass at `O(V² log V)` on the most common workspace shape.

Measured on out-degree-zero symbols, before and after:

| symbols | before | after |
|---|---|---|
| 5,000 | 223 ms | 27 ms |
| 10,000 | 810 ms | 54 ms |
| 20,000 | 3,923 ms | 72 ms |
| 40,000 | 14,196 ms | 148 ms |

A binary min-heap answers the same question the sort did — smallest ready index — bringing
the pass to `O((V + E) log V)` and leaving the emitted permutation unchanged.

`reverseTopoOrder` is now exported. The tie-break it implements is not observable through
`propagateEffects`, because the SCC aggregation is commutative and both `derivedFrom` and
the propagated entries are sorted explicitly afterwards — so pinning the permutation
requires calling the function directly.

`effect-propagation.md` described the pass as `O(V + E)`, which the previous implementation
did not meet and this one still does not: the log factor is unavoidable while the spec
mandates a deterministic minimum-index tie-break. The document now states the real bound.
