---
"@aburi/core": minor
"@aburi/cli": minor
"@aburi/types": patch
---

LSP enrichment opens each file under the language id its extension names: `.tsx` as `typescriptreact`, `.jsx` as `javascriptreact`, `.js`, `.mjs` and `.cjs` as `javascript`, and `.ts`, `.mts` and `.cts` as `typescript` as before. All eight used to be opened as `typescript`, so the server read the JSX in a `.tsx`, `.jsx` or `.js` file as type assertions, and a `this.<method>()` call inside a JSX expression hovered as `any` and landed in `hintsRejected.ownerClassNotFound`. Such a call can now resolve like the same call outside JSX, provided the server answers for the document type it is now told. A file whose extension has no known id is still opened under its language's id, and each language and extension that has to be guessed this way is now reported once.

A configuration that leaves the pass nothing to do is now reported instead of passing in silence: an `lsp.servers` key that names no loaded language plugin, such as `typescript` where the plugin id is `ts`, and a configuration in which no key matches at all, `"servers": {}` and `aburi scan --lsp` over a config with no `lsp` block included. `stats.lspEnrichment.enabled` now keeps its schema's promise: it is `false` when no language the scan found Symbols in has a server configured, and `aburi scan` says so. These lines arrive with the scan's other incidents, labelled with the side under `aburi diff`, rather than through the log. The docs and config schema now give `ts` as the key, and the `@aburi/types` patch carries the regenerated `lsp.servers` descriptions.

`EnrichmentInput` takes the loaded plugins' language ids as a required `languageIds`, which `scan` fills in; a direct caller of `enrichWithLsp` passes them, or `null` to check no key. The lines come back as `EnrichmentResult.warnings` and `ScanResult.lspWarnings`, and as `ScanReport.lspWarnings` in the CLI. Minor for `@aburi/cli` rather than patch: `ScanReport` gains the required `lspWarnings`.

Without `lsp.enabled`, which is off by default, or without an effect plugin, no fingerprint moves. With both, a caller in a `.tsx`, `.jsx`, `.js`, `.mjs` or `.cjs` file whose `this.*` call now resolves inherits that callee's effects, which moves its `logic` fingerprint, so an IR scanned before this release, compared with one scanned after, can report such a caller as changed. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed version and is unaffected.
