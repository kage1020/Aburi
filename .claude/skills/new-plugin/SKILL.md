---
name: new-plugin
description: Add a first-party framework or effects plugin package to Aburi (e.g. framework-hono, effects-kysely). Use when asked to support a new framework, ORM, queue or client library.
---

# Add a first-party plugin

Read `docs/extend/plugin-development.md` (the contracts) and the design doc for the kind of plugin
(`docs/design/effect-plugin.md`, or the framework sections of `docs/design/lang-plugin.md`) before writing
anything. Behaviour is specified there first; change the doc in the same branch if the plugin needs a
contract it does not describe.

## Copy the smallest sibling

- framework: `packages/framework-next` (file-role recognition + classify) or `packages/framework-express`
  (registration calls).
- effects: `packages/effects-trpc` or `packages/effects-prisma` (import gate → receiver → method table).

Keep the sibling's file split: `manifest.ts` (vocabulary it declares), `constants.ts`, `imports.ts`
(the import gate), `classify.ts`, `plugin.ts`, `index.ts`. Copy `package.json`, `tsconfig.json`,
`tsdown.config.ts` and `vitest.config.ts`; rename, reset `version` to `0.0.0`, rewrite `description`
and the README. Then install the sibling's runtime dependencies (`@aburi/types`, plus
`@aburi/plugin-registry` for effects or `@aburi/core` for frameworks) with the CLI, never by editing
versions in:

```bash
pnpm --filter @aburi/<name> add '@aburi/types@workspace:*' '@aburi/plugin-registry@workspace:*'
pnpm --filter @aburi/<name> add -D '@aburi/lang-typescript@workspace:*' '@aburi/test-support@workspace:*' \
  '@aburi/test-harness@workspace:*' @types/node tsdown typescript vitest
```

## Tests first

1. Write the acceptance criteria as `it(...)` titles: what the plugin classifies, what it must leave alone
   (another library with the same method names, a call without the import), and the confidence it assigns.
2. Unit-test `classify*` with the builders from `@aburi/test-support` (`makeCall`, `makeCtx`,
   `makeCandidate`).
3. Pin the end-to-end behaviour with a real scan, not a hand-rolled pipeline:
   ```ts
   const workspace = useScratchWorkspace("<name>")
   await workspace.writeSource("src/a.ts", source)
   const { ir } = await scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [plugin] })
   ```
4. Then implement until green (see the `verify` skill).

## Wire it in

- Framework plugins: the npm dependency that signals the framework goes in `NPM_DEP_TO_FRAMEWORK`
  (`@aburi/core`, component detection) and the detector id → package mapping in `FRAMEWORK_TO_PLUGIN`
  (`@aburi/cli`, plugin catalog), so `aburi init` proposes it.
- Pipeline tests that combine several plugins live in `packages/cli/test/e2e`; add the plugin as a
  devDependency of `@aburi/cli` if one needs it.
- Docs: `docs/guide/supported-stacks.md`, the root `README.md` list, and — worth it for anything users
  will search for — a showcase example (see the `add-showcase-example` skill).
- `pnpm changeset` for the new package and every published package you touched.
