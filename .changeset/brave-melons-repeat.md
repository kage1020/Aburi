---
"@aburi/core": patch
---

Make the effect-propagation sweep order sub-quadratic

`reverseTopoOrder` re-sorted the ready set on every dequeue and shifted off its front, so
both operations were linear in the size of that set. Most symbols call nothing, which
means nearly every SCC is ready from the start and the set grows to the size of the graph
— giving a quadratic sweep on the most ordinary shape a workspace has.

Measured on out-degree-zero symbols, before and after:

| symbols | before | after |
|---|---|---|
| 5,000 | 223 ms | 27 ms |
| 10,000 | 810 ms | 54 ms |
| 20,000 | 3,923 ms | 72 ms |
| 40,000 | 14,196 ms | 148 ms |

The ready set is now a binary min-heap, which answers the same question the sort did —
smallest ready index — without re-deriving it each time. The emitted order is unchanged,
so `derivedFrom`, effect ordering and every fingerprint downstream of them are unaffected;
both strategies were replayed over 3,000 randomly generated DAGs and agreed on every one.
