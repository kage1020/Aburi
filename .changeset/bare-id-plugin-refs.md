---
"@aburi/cli": minor
---

A config that names a language or framework id where a plugin belongs (`"languages": ["ts"]`) now stops with exit 2 before any plugin loads, naming the plugin to write (`lang-typescript`), instead of failing the import with exit 3. A `components[].frameworks` value that is a plugin's name (`framework-nestjs`) is kept but reported on stderr with the framework id to write. The v1 schema is unchanged; tightening its patterns is deferred to v2 (#132).
