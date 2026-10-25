---
"@aburi/cli": minor
---

A `pluginOptions` key that names no loaded plugin is now reported instead of being ignored in silence. With `"languages": ["lang-typescript"]`, `"effects": ["effects-prisma"]` and options under the misspelled `"effects-prsima"`, or options for a plugin that `languages`, `frameworks` and `effects` do not enable, `aburi scan` used to exit 0 with nothing on stderr; it now warns once per such key, naming the plugins that did load:

```
⚠ pluginOptions["effects-prsima"] names no loaded plugin (loaded: lang-typescript, effects-prisma); its options are ignored.
```

A key matches a plugin by its manifest name, so the `hint-<name>` plugin a `frameworkHints` entry is loaded as counts as loaded, and a plugin loaded by package id or path matches only under its manifest name. `aburi explain` says the line when it rescans, and `aburi diff` says it once, without a side label, since both of its scans load the head's config and plugins. The warning does not change the exit code.

Minor for `@aburi/cli` rather than patch: `ScanReport` gains the required `loadedPlugins` and `unmatchedPluginOptions`. `ScanOptions.incidents` takes an optional `said` set that the scans of one command share, and the exported `reportScanIncidents` takes the same set as an optional fourth argument.

Nothing is written to the IR or the diff, so no fingerprint moves: an IR scanned before this release compares with one scanned after exactly as before.
