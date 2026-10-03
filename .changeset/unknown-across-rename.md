---
"@aburi/diff": minor
"@aburi/types": minor
"@aburi/markdown-projection": minor
"@aburi/cli": patch
---

A file git renamed between the revisions and skipped by one scan now leaves its Symbols `unknown` instead of confidently `removed` or `added`. The skip was looked up only under the leftover's own path, while the other scan had recorded the file under its other name, so `src/big.ts → src/billing.ts` with `src/billing.ts` over the size cap at head reported every Symbol of `src/big.ts` as removed and tripped `--fail-on removed`.

- Such an entry carries the new optional `SymbolUnknown.lostPath` (`aburi.diff.v1`), the path the skipping scan recorded. `diff.md` names that path as this file's head (or base) name, where it used to name the other revision's path as the one skipped.
- Dependency edges get the same lookup, and their `lostFiles[].path` is the path the skipping scan recorded, not the holder's.
- A renamed file both scans skipped appears in `notCompared[]` under the head path, with the base path in the new optional `NotComparedFile.basePath`. `diff.md` and the stderr line name it as `base → head`.
- `diffDependencies` now requires `renames`. `RenameDirections` and `renameDirections` are exported to build it, and a caller with no rename information passes `renameDirections(null)`.
