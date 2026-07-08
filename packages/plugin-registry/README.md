# @aburi/plugin-registry

Plugin manifest validator + vocab registry. Loads every plugin's manifest,
enforces the reservation and conflict rules from
[`design/details/plugin-registry.md`](../../design/details/plugin-registry.md),
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
registry.findExtKind("framework:nestjs:controller")
// → { plugin: "framework-nestjs", baseKind: "class", ... }
```

## See also

- [`design/details/plugin-registry.md`](../../design/details/plugin-registry.md)
- [`schema/aburi.plugin.v1.json`](../../schema/aburi.plugin.v1.json)
