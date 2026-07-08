# @aburi/types

Shared TypeScript types for the Aburi ecosystem. Two flavours:

- **Schema-generated** types for the four public JSON Schemas — `aburi.ir.v1`,
  `aburi.config.v1`, `aburi.diff.v1`, `aburi.plugin.v1`. Regenerated from
  `schema/*.json` via `pnpm --filter @aburi/types codegen`; the schema is the
  source of truth, the TypeScript is a mechanical projection.
- **Hand-written** plugin interfaces (`LanguagePlugin`, `FrameworkPlugin`,
  `EffectPlugin`, `VocabRegistry`, `SymbolCandidate`, `ExtractionContext`, …)
  that the schemas cannot express — richer generic and function signatures that
  make the plugin contracts type-safe.

Every other `@aburi/*` package depends on this one. It ships no runtime code.

## Install

```bash
pnpm add @aburi/types
```

## Usage

```ts
import type { IR, Symbol as IRSymbol, DiffResult, Config } from "@aburi/types"
import type { LanguagePlugin, FrameworkPlugin, EffectPlugin } from "@aburi/types"
```

## Regenerating from schema

```bash
pnpm --filter @aburi/types codegen
# → src/generated/{ir,config,diff,plugins}.ts (do not hand-edit)
```

## See also

- [`schema/`](../../schema) — the JSON Schemas this package projects.
- [`design/details/ir-schema.md`](../../design/details/ir-schema.md) — IR contract.
- [`design/details/language-plugin.md`](../../design/details/language-plugin.md) — plugin interface.
