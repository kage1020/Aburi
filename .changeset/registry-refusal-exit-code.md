---
"@aburi/cli": patch
---

A plugin manifest the registry refuses exits 3, not 1

A `RegistryError` thrown while registering a loaded plugin's manifest (a reserved namespace, an
`xPrefix` mismatch, a duplicate id, a prefix overlap, a name collision, an invalid `provides`)
escaped `loadPlugins` uncoded, so the CLI reported it as a crash with exit 1. It is now a
`CliError` with code `plugin-error`, which exits 3 as `cli-spec.md` specifies for a manifest
violation. The message is the registry's own, unchanged, and the `RegistryError` is kept as
`cause`.
