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

It also owns the shared guards that enforce the language plugin's input contract
for effect plugins — see [Input guards](#input-guards-aburiplugin-registryplugin-input)
below.

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

## Input guards (`@aburi/plugin-registry/plugin-input`)

A second, deliberately tiny surface: the fail-fast guards that enforce the
language plugin's normalized-output contract
([`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §4.4) before an
effect plugin reads the value.

```ts
import { assertNonEmptySegments, hasMatchingImport } from "@aburi/plugin-registry/plugin-input"

const origin = { plugin: "effects-mytool", filePath: ctx.file.path }

// Throws on "", ".create", "db..insert", "db.select." — never returns a bad split.
const { segments, last } = assertNonEmptySegments(call.target, origin)

// Throws on an ImportEdge with an empty source, checking every edge before matching
// so throw behaviour does not depend on import order.
const usesMyTool = hasMatchingImport(ctx.file.imports, origin, (source) => source === "mytool")
```

They live here rather than in each effect plugin so every plugin throws the same
message, naming the plugin and the file that produced the bad value.

**Import them from the `/plugin-input` subpath, not the package root.** The root
barrel compiles the plugin JSON Schema with ajv at module scope; the subpath is a
separate, dependency-free chunk, which is what keeps that compilation out of a
classifier's startup path.

## See also

- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — namespace ownership, reservation rules, conflict semantics.
- [`schema/aburi.plugin.v1.json`](../../schema/aburi.plugin.v1.json)
