---
"@aburi/cli": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Add `--quiet` to `aburi scan` and `aburi diff`, and `--filter` to `aburi diff`

`aburi scan --quiet` prints the two census lines alone, and `aburi diff --quiet` the glyph line alone; stderr, the files written and the exit code are unchanged.

`aburi diff --filter <statuses>` lists only the changes of the statuses named in `diff.md`, with a note under the Summary saying how many it left out. A Slice holding a kept change is drawn whole, and component changes, dependency changes and Not compared are listed in full. `diff.json`, the glyph line and `--fail-on` still read every change, and a `--fail-on` clause that counts only statuses the filter leaves out is warned about on stderr. An empty value, an empty segment or a word that is no status exits 2.

`projectDiff` takes the filter as its `statuses` option, and `@aburi/types` exports every `SymbolChange` status as `SYMBOL_CHANGE_STATUSES`, with its type `SymbolChangeStatus`.
