---
"@aburi/core": minor
"@aburi/plugin-registry": minor
"@aburi/cli": patch
"@aburi/config": patch
"@aburi/diff": patch
"@aburi/markdown-projection": patch
"@aburi/lang-typescript": minor
"@aburi/effects-drizzle": patch
"@aburi/effects-prisma": patch
"@aburi/effects-nest": patch
"@aburi/effects-trpc": patch
"@aburi/framework-express": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-next": patch
"@aburi/framework-react": patch
"@aburi/github-action": patch
"@aburi/types": patch
---

Internal refactor: trim narrative comments, share duplicated helpers, collapse redundant tests, and rename unclear identifiers across the workspace. Public exports are unchanged apart from additions.

- `@aburi/core` now exports the ordering helpers (`compareCodeUnit`, `compareBy`, `stringArraysEqual`), the collection helpers (`groupBy`, `countBy`) and the tree-sitter shim (`SyntaxNode`, `asSyntaxNode`, `findNamedChildOfType`, `findFirstDescendantOfType`, `calleeText`, `calleeLeaf`, `anyCallCalleeMatches`) that the framework plugins previously each carried a copy of.
- `@aburi/plugin-registry/plugin-input` gains `receiverConfidence`, `defineEffectsManifest` and `matchesModuleOrSubpath`, which the four effects plugins now share.
- `@aburi/lang-typescript` reads string-literal call arguments through the same decoder as member
  names, so an escape sequence inside a route path or `literalArgs` entry is now decoded instead of
  dropped. **This moves Symbol ids and `fingerprints.api`** for any call whose literal carries an
  escape: `app.get("/us\u0065rs")` was `$usrs` and is now `$users`, and `db.query("SELECT\t1")`
  reports `literalArgs` as `["SELECT<TAB>1"]` rather than `["SELECT\\t1"]`. The first `aburi diff`
  after updating reports those Symbols as changed. Hence the minor bump.
- `@aburi/core` `detectWorkspaceRoot` no longer aborts on a `package.json` / `Cargo.toml` /
  `pyproject.toml` it could not read in a directory **above** the root it settles on. The walk asks
  every ancestor whether it declares workspaces, so a malformed or unreadable manifest outside the
  project — `$HOME/package.json` at mode 600 on a shared machine — used to fail the whole command
  with a path the reader has no business fixing. A failure at or below the settled root is still
  raised, unchanged: that one is the workspace's own, and absorbing it would root every Symbol id at
  the package the command was run from. `aburi scan` is where this is observable.
- `@aburi/cli` `init` resolves the workspace root through the same code path as `scan`. With the
  above in place this is a refactor and not a behaviour change: a malformed root manifest still
  exits 1 out of `detectManagers`, and a manifest above the root still does not fail the command.
- `@aburi/framework-react` `calleeText` returns `null` rather than `""` for an empty callee, matching `@aburi/framework-express`.
