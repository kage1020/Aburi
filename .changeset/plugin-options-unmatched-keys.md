---
"@aburi/cli": patch
---

A `pluginOptions` key that names no loaded plugin is now reported instead of being ignored in silence. With `"effects": ["effects-prisma"]` and options under the misspelled `"effects-prsima"`, or options for a plugin that `languages`, `frameworks` and `effects` do not enable, `aburi scan` used to exit 0 with nothing on stderr; it now warns once per such key, naming the plugins that did load:

```
⚠ pluginOptions["effects-prsima"] names no loaded plugin (loaded: lang-typescript, effects-prisma); its options are ignored.
```

The `hint-<name>` plugin a `frameworkHints` entry is loaded as counts as loaded. `aburi explain` says the line when it rescans, and `aburi diff` says it once, without a side label, since both of its scans load the head's config and plugins. The warning does not change the exit code. `ScanReport` gains `loadedPlugins` and `unmatchedPluginOptions`, and `ScanOptions.incidents` takes an optional `said` set that the scans of one command share.

Nothing is written to the IR or the diff, so no fingerprint moves: an IR scanned before this release compares with one scanned after exactly as before.
