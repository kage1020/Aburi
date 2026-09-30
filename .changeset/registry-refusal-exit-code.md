---
"@aburi/cli": patch
---

A loaded plugin's manifest the registry refuses exits 3, not 1

A `RegistryError` thrown while registering a loaded plugin's manifest (such as an id or prefix
in a reserved namespace, a namespace the plugin's type may not own, an `xPrefix` mismatch, an id
or prefix another plugin already declared, or an invalid manifest) left `loadPlugins` without a
`CliError` code, so the CLI reported it as a runtime failure (exit 1). It is now a `CliError`
with code `plugin-error`, which exits 3 as `cli-spec.md` specifies for a manifest violation. The
message stays the registry's own, and the `RegistryError` is kept as `cause`.

Manifests derived from `frameworkHints` are not covered: a refusal there is a config error, not
a plugin fault, and still exits 1.
