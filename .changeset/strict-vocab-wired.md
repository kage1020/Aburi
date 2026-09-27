---
"@aburi/core": minor
"@aburi/cli": minor
---

`strict` now does what the config documents (#128)

`config.strict` was accepted and never read, and `aburi scan` had no `--strict` flag, so a
plugin could emit an effect id or extKind its manifest never declared and nothing noticed.
Now:

- Every effect id and extKind a plugin emits is checked against that plugin's own manifest.
  Core effect ids pass whoever emits them.
- Strict (the default), the run stops at the first undeclared value with exit 3, naming the
  plugin, the value and the file.
- With strict off (`"strict": false`, `--no-strict` or `--discover`), the scan keeps the value
  and writes every one to `aburi-vocab-discovered.json` in the output directory. `aburi diff`
  lists them on each scan's incident report instead.
- `aburi scan` gains `--strict`, `--no-strict` and `--discover`; `--strict --discover` exits 2.
- A strict `aburi scan` that completes removes an `aburi-vocab-discovered.json` an earlier run
  left.
- `ScanResult.undeclaredVocab` and `ScanReport.undeclaredVocab` carry what a non-strict run
  found, and `isStrict(config)` says which a config asks for.
- Breaking for a direct caller of `runFilePipeline`: it now requires a `vocab` check
  (`new VocabCheck(registry, isStrict(config))`), which raises in a strict run and holds what a
  non-strict one found in `vocab.occurrences`. `VocabCheck` decides through the registry's
  `assertEffectDeclared` / `assertExtKindDeclared`.
