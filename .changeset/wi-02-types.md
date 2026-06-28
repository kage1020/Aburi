---
"@aburi/types": minor
---

Introduce the `@aburi/types` package. Auto-generates TypeScript declarations from the four public JSON Schemas (`aburi.ir.v1`, `aburi.config.v1`, `aburi.diff.v1`, `aburi.plugin.v1`) via `json-schema-to-typescript`, and adds hand-written contracts for `LanguagePlugin`, `EffectPlugin`, `FrameworkPlugin`, `VocabRegistry`, and the supporting `SymbolCandidate` / `CallCandidate` / `ParseResult` / `*Context` graph. Build artifact is `.d.mts` with an empty runtime stub. Regenerate with `pnpm --filter @aburi/types codegen`.
