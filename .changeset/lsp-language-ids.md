---
"@aburi/core": minor
---

LSP enrichment opens each file under the language id its extension names, so a `.tsx` or `.jsx` file reaches the server as `typescriptreact` or `javascriptreact` and its JSX is parsed as JSX. A `this.<method>()` call inside a JSX expression used to hover as `any` and land in `hintsRejected.ownerClassNotFound`; it now resolves like the same call outside JSX. An `lsp.servers` key that names no loaded language plugin, such as `typescript` where the plugin id is `ts`, now produces a warning instead of a server that is silently never started. The docs and config schema now give `ts` as the key. `EnrichmentInput` takes the loaded plugin ids as an optional `languageIds`, which `scan` fills in; a caller that leaves it out gets no warning.

With an effect plugin loaded, a caller in a `.tsx` or `.jsx` file whose `this.*` call now resolves inherits that callee's effects, which moves its `logic` fingerprint. An IR scanned before this release, compared with one scanned after, can report such a caller as changed. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed version and is unaffected.
