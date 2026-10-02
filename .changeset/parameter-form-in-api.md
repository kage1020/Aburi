---
"@aburi/lang-typescript": patch
"@aburi/markdown-projection": patch
---

A parameter's optional marker, default and rest marker now reach the `api` fingerprint. `signature.inputs[].type` opens with `?` for an optional or defaulted parameter and with `...` for a rest parameter (whose `name` is now the bare binding, `ids` rather than `...ids`), because `type` is what the api fingerprint hashes. Making an optional parameter required, dropping a default, or turning `T[]` into `...T[]` used to leave every fingerprint identical, so `aburi diff` reported no change and `--fail-on api-changed` passed. The Markdown report prints the markers where TypeScript writes them (`a?: string`, `...ids: string[]`). Functions with an optional, defaulted or rest parameter get a new `api` value once.
