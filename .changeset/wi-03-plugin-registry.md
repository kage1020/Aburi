---
"@aburi/plugin-registry": minor
"@aburi/types": patch
---

Introduce the `@aburi/plugin-registry` package. Validates plugin manifests via ajv against `aburi.plugin.v1.json`, then registers their owned extKind / effect id / framework / derivedBy namespaces while enforcing reserved-namespace exclusivity (`core` / `aburi` / `_` / `framework:hint`), xPrefix derivation and consistency, type-namespace ownership, prefix-id shadowing, and prefix-prefix overlap in both directions. Surfaces `VocabRegistry`, `RegistryError`, `loadPluginManifest`, `parsePluginManifest`, and the `RESERVED_NAMESPACES` / `TYPE_NAMESPACE_RULES` constants.

`@aburi/types` patch: `EffectVocab.description` and `ExtKindVocab.{baseKind, description}` are now nullable to model registry resolution through prefix ownership (`findEffect` / `findExtKind` return non-null for prefix-owned ids that the plugin did not enumerate individually).
