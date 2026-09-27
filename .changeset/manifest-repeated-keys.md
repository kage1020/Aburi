---
"@aburi/plugin-registry": minor
"@aburi/config": patch
---

A plugin manifest that names one key twice in an object is refused as `manifest-invalid`

JSONC parsing keeps the last of two equal keys and says nothing, so a manifest that wrote `"name"`
twice registered under the second, and the registry's duplicate checks ran on whichever entry
survived. `parsePluginManifest` now refuses a repeated key at any depth, and `__proto__` at all,
naming the key, its object and the line, as `aburi.json` already did. The walk behind both is
exported from `@aburi/plugin-registry` as `findRepeatedKey` and `describeRepeatedKey`, and
`@aburi/config` uses it from there; config behaviour is unchanged.
