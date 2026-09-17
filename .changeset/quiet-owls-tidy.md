---
"@aburi/core": minor
"@aburi/plugin-registry": minor
"@aburi/cli": patch
"@aburi/config": patch
"@aburi/diff": patch
"@aburi/markdown-projection": patch
"@aburi/lang-typescript": patch
"@aburi/effects-drizzle": patch
"@aburi/effects-prisma": patch
"@aburi/effects-nest": patch
"@aburi/effects-trpc": patch
"@aburi/framework-express": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-next": patch
"@aburi/framework-react": patch
"@aburi/github-action": patch
---

Internal refactor: trim narrative comments, share duplicated helpers, collapse redundant tests, and rename unclear identifiers across the workspace. Public exports are unchanged apart from additions.

- `@aburi/core` now exports the ordering helpers (`compareCodeUnit`, `compareBy`, `stringArraysEqual`), the collection helpers (`groupBy`, `countBy`) and the tree-sitter shim (`SyntaxNode`, `asSyntaxNode`, `findNamedChildOfType`, `findFirstDescendantOfType`, `calleeText`, `calleeLeaf`, `anyCallCalleeMatches`) that the framework plugins previously each carried a copy of.
- `@aburi/plugin-registry/plugin-input` gains `receiverConfidence`, `defineEffectsManifest` and `matchesModuleOrSubpath`, which the four effects plugins now share.
- `@aburi/lang-typescript` reads string-literal call arguments through the same decoder as member names, so an escape sequence inside a route path or `literalArgs` entry is now decoded instead of dropped.
- `@aburi/cli` `init` resolves the workspace root through the same code path as `scan`, so a malformed root `package.json` is reported instead of silently treated as the root.
- `@aburi/framework-react` `calleeText` returns `null` rather than `""` for an empty callee, matching `@aburi/framework-express`.
