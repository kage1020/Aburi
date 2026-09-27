---
"@aburi/plugin-registry": patch
---

Refuse a malformed `provides` entry with a coded error

`VocabRegistry.register` checked that each `provides` array existed, but not what the arrays held.
A manifest built by hand rather than read through `loadPluginManifest` could carry a `null` effect,
an extKind without an `id`, or a number among the prefixes, and `register` then failed with a bare
`TypeError` such as `Cannot read properties of null (reading 'id')`. It now throws a
`RegistryError` with code `manifest-invalid` that names the plugin and the entry, for example
`Plugin "effects-prisma" provides.effects[1] must be an object (got null).` Each effect needs its
own string `id` and `description`, each extKind also a string `baseKind`, and the prefix and
framework arrays hold strings. A non-array `provides` field now reads `(got null)` rather than
`(got object)` when it is `null`.
