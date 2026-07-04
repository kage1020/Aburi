---
"@aburi/lang-typescript": minor
---

Introduce `@aburi/lang-typescript`, the first Aburi language plugin. Implements the full lang-plugin.md contract on top of `web-tree-sitter` and the pre-built typescript / tsx grammars from `@vscode/tree-sitter-wasm`:

- **`parseFile`** — lazily initializes the WASM runtime once per process and caches every loaded grammar. Each call creates a fresh `Parser`, parses the file, collects recoverable syntax errors from the tree, and releases the parser before returning so the WASM heap stays flat across long scans (the discipline documented in lang-plugin.md §8.1).
- **`extractSymbols`** — surfaces top-level functions / classes / interfaces / type aliases / enums / namespaces / variable-assigned functions, class instance and static methods (with `.` vs `::` separators), the reserved `<default>` sentinel for anonymous default exports, and nested namespace paths. Populates `Signature` with async / generator flags, positional inputs with names + types, outputs, sorted throws (both `throw new X()` statements and JSDoc `@throws {X}` tags), and type parameters. Extracts decorators with raw / arguments / line preserved (boundary defaults to false for framework plugins to override).
- **`walkBody`** — emits guard / throw / return / loop / try / switch rules with the drop-list `isTrivialReturn` rule fully implemented (literal / identifier / member-chain / unary-of-trivial returns are dropped; `return f()` records the call but skips the rule). CallCandidate captures `target`, `line`, `argumentCount`, `inAwait`, `inNew`, and per-argument literal values.
- **`normalizeAst`** — emits a positionless, comment-free, whitespace-free S-expression with identifier and literal values preserved. Feeds `syntaxFingerprint` in `@aburi/core`.
- **`symbolDropHint`** — Category B hints for interface (`interface (data model)`), type alias, pure DTO, pure constants, and empty function body. Category A file patterns cover `**/*.d.ts` / `**/*.d.mts` / `**/*.d.cts`.
- **Import extraction** — static named / default / namespace / bare / mixed imports, `export ... from ...` re-exports, and dynamic `import()` calls collapse into a normalized `ImportEdge[]`.

Public API: `langTypescriptPlugin` (ready-to-register instance), `LangTypescriptPlugin` (class), `langTypescriptManifest`, `parseTypescriptFile`, `extractSymbols`, `walkBody`, `normalizeAst`, `extractImports`, `classifySymbolDropHint`, `TYPESCRIPT_FILE_DROP_PATTERNS`.
