---
"@aburi/lang-typescript": minor
"@aburi/types": minor
"@aburi/core": minor
"@aburi/cli": minor
---

Separate the `LanguageId` and `PluginRef` vocabularies

`aburi.json` uses the key `languages` at two nesting levels with two different
vocabularies: the top-level array holds plugin refs the loader resolves as module
specifiers, while `components[].languages` holds `LanguageId`s constrained to
`^[a-z][a-z0-9]*$`. Both writers conflated them.

- `LanguagePlugin` gains a required `languageId` field. `@aburi/core` projects it into
  `IR.workspace.languages`, which previously received `manifest.name` and therefore
  emitted `"lang-typescript"` — a value that fails the frozen `aburi.ir.v1` schema for
  every first-party plugin. Third-party language plugins must add the field.
- `aburi init` now writes plugin manifest names (`lang-typescript`, `framework-nestjs`)
  in the top-level arrays and keeps `LanguageId`s inside `components[]`. It previously
  wrote detector ids, so the loader looked for the non-existent `@aburi/ts` package and
  the documented `init` then `scan` quick start failed on every project.
