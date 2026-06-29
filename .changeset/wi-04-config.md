---
"@aburi/config": minor
"@aburi/plugin-registry": patch
---

Introduce the `@aburi/config` package. Parses `aburi.json` / `aburi.jsonc` (JSONC with comments and trailing commas) through `jsonc-parser`, validates against `aburi.config.v1.json` via ajv strict mode, and surfaces typed errors with parse offsets / filesystem errno embedded in the message. Normalizes `frameworkHints[]` into synthesized framework-type `PluginManifest` entries by auto-inserting `hint:` as the second segment of each `extKind` value, deriving `extKindPrefixes` / `derivedByPrefixes` ownership from the resulting values, and rejecting user-written `framework:hint:*` extKinds. Adds workspace-walking config discovery (`aburi.jsonc` preferred over `aburi.json`, returns `null` when no ancestor has a config so the consumer can fall back to autodetect). Public API: `loadConfig`, `parseConfig`, `readConfigFile`, `findConfig`, `normalizeFrameworkHints`, `ConfigError`, plus `LoadedConfig` / `FindConfigOptions` / `ConfigErrorCode` types.

`@aburi/plugin-registry` patch: `loadPluginManifest` now extracts the filesystem errno from Node `SystemError` instances (which inherit from `Error` and were previously rejected by the plain-object guard), so failure messages include `ENOENT` / `EACCES` / `EISDIR` instead of falling back to `unknown`.
