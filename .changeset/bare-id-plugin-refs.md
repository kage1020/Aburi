---
"@aburi/cli": minor
"@aburi/types": patch
---

A config that names a language or framework id where a plugin belongs (`"languages": ["ts"]`) now stops with exit 2 before any plugin loads, naming the plugin to write (`lang-typescript`), instead of failing the import with exit 3. A `components[].frameworks` value that is a plugin's name (`framework-nestjs`) is kept but reported on stderr with the framework id that plugin provides, or with the advice to remove it when the plugin provides none. A value in neither set (a framework id no plugin provides, or a typo) still passes unchecked, since the detector records framework ids no plugin provides. The v1 schema patterns are unchanged; tightening them is deferred to v2 (`config.md` §14.1). The `@aburi/types` patch carries the regenerated `PluginRef`, `components[].frameworks` and `Component.frameworks` descriptions.
