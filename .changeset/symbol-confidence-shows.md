---
"@aburi/types": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/cli": minor
---

A Symbol's confidence shows on its heading, and the diff reports a change to it

`Symbol.confidence` was written and validated but never rendered or compared, so a Symbol the
machine was unsure of looked like any other outside the raw IR. Now:

- Every Markdown heading that names a Symbol (component pages, `diff.md` entries, `explain`,
  kept or dropped), and the names-only row that replaces one under the size cap, carries
  `⚠ medium` or `⚠ low` after the kind when its confidence is not `high`.
- `aburi diff` treats a confidence change as a change even when no fingerprint moved: the pair
  is `changed`, and counts toward `--fail-on changed`, or `moved+changed` when it also moved. A
  pair dropped on both sides stays `unchanged`. One edit can move every Symbol in a file, since
  a plugin may read a file-level signal such as an import.
- `--fail-on confidence-changed` gates on that axis alone and takes a threshold;
  `--fail-on api-changed,logic-changed` ignores it.
- `SymbolDelta` gains `confidenceChanged`, an optional boolean in `aburi.diff.v1.json` that the
  writer always emits.
- `diff.md` adds a `- confidence: <base> → <head>` row to the entry, and a new
  "🎚 Confidence changes" section, above Syntax-only changes, holds entries whose API and logic
  did not change. The "no field-level detail" note no longer disappears beside a component or
  confidence row, since neither explains a fingerprint.
- `symbolTitle` is exported from `@aburi/markdown-projection`.
