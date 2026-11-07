---
"@aburi/plugin-registry": minor
---

The shared input guards in `@aburi/plugin-registry/plugin-input` throw `PluginInputError` instead of a bare `Error`. Its `code` says what the language plugin emitted malformed (`unnormalized-callee`, `unnormalized-import-source`, `unnormalized-import-binding`, `unnormalized-namespace-binding`), and `plugin` and `filePath` say where, so a consumer branches on the code without reading the message. The scan keeps the code on the withdrawn file's `extractionFailures` entry. Messages are unchanged.
