---
"@aburi/markdown-projection": minor
---

The diff report names the Symbol a removal duplicated. A `removed` entry whose `duplicateOf` names a head Symbol carries ``**Duplicate of**: `<id>`, which holds the same body`` under its **File** line, its names-only row ends `` (duplicate of `<id>`) ``, and the Summary line reads `-N removed (M duplicates)` when `summary.removedDuplicates` is non-zero, `(1 duplicate)` for one. The glyph line `projectDiffSummaryLine` writes is unchanged.

`FailOnStatus` and `FAIL_ON_STATUSES` gain `removed:duplicate`, so an exhaustive `switch` over `FailOnStatus` needs the case. `evaluateFailOn` reads `removed` as the removals that are not duplicates, as the CLI's gate does, so a `removed` threshold no longer counts every removal. It throws on a summary whose `removedDuplicates` exceeds `removed` rather than gate on a negative count.
