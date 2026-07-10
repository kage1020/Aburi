# @aburi/plugin-registry

Plugin manifest validator + vocab registry. Loads every plugin's manifest,
enforces the reservation and conflict rules from
[`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md),
and answers the runtime lookups the scan / diff paths need:

- Which plugin owns this `extKind` / `effect id` / `framework` / `derivedBy`
  namespace?
- Is this `extKind` declared by any loaded plugin?
- Is this `effect id` allowed to be emitted by that plugin?

`VocabRegistry` is a pure runtime lookup table — no side effects on lookup, no
lazy load. Callers hand it every manifest at startup and it enforces conflicts
eagerly.

## Install

```bash
pnpm add @aburi/plugin-registry
```

## Usage

```ts
import { VocabRegistry } from "@aburi/plugin-registry"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"

const registry = new VocabRegistry()
registry.register(langTypescriptPlugin.manifest)
registry.register(nestjsFrameworkPlugin.manifest)

// Attempts to re-register a conflicting namespace throw.
const vocab = registry.findExtKind("framework:nestjs:controller")
// vocab === {
//   id: "framework:nestjs:controller",
//   baseKind: "class",
//   description: "...",
//   owner: <the framework-nestjs PluginManifest>,
// }
```

`findExtKind` / `findEffect` / `findFramework` return an object whose `owner`
field is the full `PluginManifest` that claimed the namespace (not just the
plugin's name). Callers that only need the name read `owner.name`.

## See also

- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — namespace ownership, reservation rules, conflict semantics.
- [`schema/aburi.plugin.v1.json`](../../schema/aburi.plugin.v1.json)
