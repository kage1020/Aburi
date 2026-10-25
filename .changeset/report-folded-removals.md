---
"@aburi/markdown-projection": minor
---

The diff report names the Symbol a removal was folded into. A `removed` entry whose `foldedInto` names a head Symbol carries `**Folded into**: \`<id>\`, which holds the same body` under its **File** line, its names-only row ends `(folded into \`<id>\`)`, and the Summary line reads `-N removed (M folded)` when `summary.removedFolded` is non-zero. The glyph line `projectDiffSummaryLine` writes is unchanged. `evaluateFailOn` reads `removed` as the removals that were not folded and accepts `removed:folded`, as the CLI's gate does.
