---
"@aburi/cli": minor
---

A `pluginOptions` key that names no loaded plugin is now reported instead of being ignored in silence. With `"languages": ["lang-typescript"]`, `"effects": ["effects-prisma"]` and options under the misspelled `"effects-prsima"`, or options for a plugin that `languages`, `frameworks` and `effects` do not enable, `aburi scan` used to exit 0 with nothing on stderr; it now warns once per such key, naming the plugins that did load:

```
⚠ pluginOptions["effects-prsima"] names no loaded plugin (loaded: lang-typescript, effects-prisma).
```

A key matches a plugin by its manifest name, and a plugin loaded by package id or path matches only under its manifest name. The `hint-<name>` plugin a `frameworkHints` entry is loaded as counts as loaded, but Aburi builds it from the entry and it reads no options, so a key for it gets a line of its own:

```
⚠ pluginOptions["hint-acme"] names the plugin built from the frameworkHints entry "acme", which takes no options; write its rules in that entry.
```

The lines follow the keys' config order. `aburi explain` says them when it rescans, and `aburi diff` says each once, without a side label, since both of its scans load the head's config and plugins. The warnings do not change the exit code.

No plugin that ships with Aburi reads `pluginOptions`, and the documentation no longer shows options for `effects-prisma` and `framework-nestjs`: `treatExtendsAsTx` and `considerHttpExceptionAsThrow` never existed. The field is for third-party plugins, which read their own key from `ctx.config` in their extraction and classification hooks.

Minor for `@aburi/cli` rather than patch: `ScanReport` gains the required `loadedPlugins` and `strayPluginOptions`, one `StrayPluginOptions` (`{ key, hintEntry }`, `hintEntry` null for a key that names no loaded plugin) per reported key. `ScanOptions.incidents` takes an optional `said` set that the scans of one command share, and the exported `reportScanIncidents` takes the same set as an optional fourth argument.

Nothing is written to the IR or the diff, so no fingerprint moves: an IR scanned before this release compares with one scanned after exactly as before.
