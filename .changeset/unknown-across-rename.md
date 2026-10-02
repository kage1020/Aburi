---
"@aburi/diff": patch
"@aburi/types": minor
"@aburi/markdown-projection": patch
---

A file git renamed between the revisions and skipped by one scan now leaves its Symbols `unknown` instead of confidently `removed` or `added`. The skip was looked up only under the leftover's own path, while the other scan had recorded the file under its other name, so `src/big.ts → src/billing.ts` with `src/billing.ts` over the size cap at head reported every Symbol of `src/big.ts` as removed and tripped `--fail-on removed`. Dependency edges get the same lookup, and their `lostFiles[].path` is the path the skipping scan recorded. A renamed file both scans skipped now appears in `notCompared[]` once, under the head path, with the base path in the new optional `basePath` field (`aburi.diff.v1`); the Markdown report names it as `base → head`.
