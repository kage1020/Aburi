---
"@aburi/types": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
---

A Symbol's confidence shows on its heading, and the diff reports a change to it

`Symbol.confidence` was written and validated but never rendered or compared, so a Symbol the
machine was unsure of looked like any other outside the raw IR. Now:

- Every Markdown heading that names a Symbol (component pages, `diff.md` entries, `explain`)
  ends in `⚠ medium` or `⚠ low` when its confidence is not `high`.
- `aburi diff` treats a confidence change as a change even when no fingerprint moved: the pair
  is `changed` (or `moved+changed`) and counts toward `--fail-on changed`. A pair dropped on both
  sides stays `unchanged`.
- `SymbolDelta` gains `confidenceChanged`, an optional boolean in `aburi.diff.v1.json` that the
  writer always emits.
- `diff.md` adds a `- confidence: <base> → <head>` row to the entry, and a new
  "🎚 Confidence changes" section, above Syntax-only changes, holds entries whose API and logic
  did not change.
- `symbolTitle` is exported from `@aburi/markdown-projection`.
