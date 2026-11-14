---
"@aburi/types": patch
---

The JSON Schema descriptions shipped as JSDoc on the config, IR and plugin manifest types now say what Aburi does: an empty config loads no language plugin, `frameworks` order decides which plugin classifies a Symbol first, `respectGitignore` is decided per file as git decides it, `keep` escapes call drops only, a hint's extKind prefix is unique per vendor, `generatedAt` is written by no producer today, `stats.lspEnrichment` is absent whenever the LSP pass is off, `wasmHeapPerWorkerMB` caps the parser worker count, and a plugin's manifest is checked by the registry at load time rather than by the schema.
