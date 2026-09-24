---
"@aburi/diff": patch
---

The `lineFuzz` error no longer points at a config key that does not exist

An out-of-range `lineFuzz` said `config.diff.lineFuzz must be …`, and the design doc offered
that key as a setting, but `aburi.json` has no `diff` key and writing one fails validation. The
window stays at `2` for the CLI: since unchanged elements pair at any distance, it only decides
whether an edit reads as `modified` or as `added` + `removed`. The error now names the
`lineFuzz` option that `computeSymbolDelta` and `buildDiff` accept, and the doc stops offering
the setting.
