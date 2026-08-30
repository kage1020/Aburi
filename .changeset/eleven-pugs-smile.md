---
"@aburi/diff": minor
"@aburi/core": minor
---

Name the field a diffed IR is missing, instead of crashing on it

`buildDiff` is public API and ran no integrity check, so an IR a caller assembled in memory
reached the matcher unverified. Every field the diff dereferences crashed it with a bare
`TypeError` naming neither the record nor the field — measured, one field deleted at a time
from a well-formed pair:

| deleted | crashed in |
|---|---|
| `symbols[].fingerprint`, `.source` | `classifyStatus` |
| `symbols[].calls`, `.decorators`, `.effects`, `.rules` | `computeSymbolDelta` |
| `components[].roots` | `diffComponents` |
| `stats` | `dependencySideView`, which reads `stats.skippedFiles` off every side |

That list is the shape of the class rather than the whole of it: it is one matcher change
away from being out of date, which is the argument for a gate that is not scoped to it.

`buildDiff` now runs `checkDocumentShape` on each side before the identity pass. The refusal
is a `DiffError` with code `ir-shape-invalid`, naming the side, the record and the field:
`headIR.symbols[3]: "fingerprint" is absent, not an object.` A breach at the top level has no
index to name and says so — `headIR: "stats" is absent, not an object.`

**Invariant #20, and only #20.** The semantic invariants are statements about a Document whose
answer the diff does not depend on — an unsorted `symbols[]` diffs correctly, because stage 1
keys by id — so running them would withhold an answer the matcher can give, and `aburi diff`
would re-pay the full checker on a Document `readIR` already checked. It re-pays the structural
walk instead: 1.8ms per side at 1,000 Symbols, 17ms at 10,000.

**This refuses IRs that used to produce an answer.** A Symbol missing `visibility`, `name` or
`kind` was diffed happily, because nothing in the matcher dereferenced it; so was a Document
with no `generator` or `workspace`. The gate is scoped to what the `IR` brand asserts rather
than to what today's matcher touches: a scope that moved with the matcher would leave a
caller's Document conditionally valid, and `integrity-shape.ts` makes that argument for itself
while naming this consumer.

`DiffErrorDetail` gains `violations?: readonly IntegrityViolation[]`, matching
`CoreErrorDetail`. The message quotes the first breach and counts the rest, which is enough to
start on and not enough to finish; the array carries all of them, each subject prefixed with
the side it came from. Additive — no existing field changed.

`checkDocumentShape` and `DOCUMENT_SUBJECT` are now exported from `@aburi/core`. The first was
module-exported only, reachable solely through `checkIRIntegrity`, which runs it and then the
semantic checks this deliberately avoids. The second is what tells a root-level breach from a
nested one, and a hand-copied literal on the diff side would go quietly wrong if core renamed
it.

The messages are the ones `checkDocumentShape` writes, subject naming the record and message
naming the field, rather than a second wording for the same breach — including the empty
`$schema`, which is `buildDiff`'s own requirement and now reads in the same shape. Callers
matching on `DiffError.message` for a malformed Document see the new form; `code` is unchanged.
