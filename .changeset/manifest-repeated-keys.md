---
"@aburi/plugin-registry": minor
"@aburi/config": patch
---

`parsePluginManifest` refuses JSONC that names one key twice in an object, as `manifest-invalid`

`jsonc-parser` keeps the last of two equal keys and says nothing, so a JSON manifest that wrote
`"name"` twice registered under the second, and the registry's duplicate checks ran on whichever
entry survived. `parsePluginManifest` and `loadPluginManifest` now refuse a repeated key at any
depth, and `__proto__` at all, naming the key, its object and the line, as `aburi.json` already
did. This guards the published API and third-party plugins that read their own JSON manifest; a
manifest exported from a TypeScript module, as the first-party plugins' are, never goes through
JSONC. A schema failure's `cause` is now ajv's `ErrorObject[]`, as in `@aburi/config`.

The scan is published as `@aburi/plugin-registry/repeated-keys` (`scanKeys`,
`describeRepeatedKey`, `JSONC_PARSE_OPTIONS`, and the `RepeatedKey` and `KeyScan` types), a
subpath that does not compile the plugin schema. `@aburi/config` reads it from there. For
`aburi.json` the `__proto__` message now says the parser assigns the key instead of defining it,
an object path escapes `~` and `/` as JSON Pointer does, and the `cause` of a key error carries
`kind`, `owner` (formerly `path`), `offset` and `length` as well.
