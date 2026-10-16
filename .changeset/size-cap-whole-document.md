---
"@aburi/markdown-projection": patch
---

`projectDiff` with `maxBytes` (and `aburi diff --max-bytes`) now counts the size-cap note when choosing between a section's full and names-only forms. A section with one or two thin entries stays whole where that makes the report no larger, also below a names-only section, where it used to be named only in a longer report or omitted although it fit. A section is no longer left out while the finished report has room for it.
