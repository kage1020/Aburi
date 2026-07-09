# @aburi/lang-typescript

TypeScript / TSX language plugin for `@aburi/core`. Parses via tree-sitter WASM
(no native build step, ships zero-install on macOS / Linux / Windows) and emits
`SymbolCandidate`s the core pipeline can classify.

Responsibilities:

- **`parseFile`** — tree-sitter parse with syntactic error recovery.
- **`extractSymbols`** — top-level and class-nested Symbols (functions, classes,
  methods, interfaces, type aliases, exports).
- **`walkBody`** — visits the body of each Symbol to collect `Rule`s (guards,
  throws, try/catch) and `CallCandidate`s.
- **`normalizeAst`** — canonical AST string for the `logic` fingerprint (whitespace
  / comment insensitive, identifier-preserving).
- **`symbolDropHint`** — additional drop candidates the core's shape-only rules
  cannot judge (e.g. `{}` empty bodies).
- **`Signature` extraction** — JSDoc `@throws` reads, param + return positions,
  `readonly` / `abstract` tracking.

Emits `SymbolCandidate.id` under the `ts:` language prefix per the id contract in
`design/details/ir-schema.md §3.1`.

## Install

```bash
pnpm add @aburi/lang-typescript
```

## Usage

```ts
import { langTypescriptPlugin } from "@aburi/lang-typescript"

// Pass to @aburi/core scan or the CLI's plugin loader — @aburi/cli discovers
// this plugin by name (`typescript` / `ts`) from an autodetected config.
```

## See also

- [`design/details/lang-plugin.md`](../../design/details/lang-plugin.md)
- [`design/details/drop-list.md`](../../design/details/drop-list.md)
