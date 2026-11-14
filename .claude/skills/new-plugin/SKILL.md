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

Keep the sibling's file split — at least `manifest.ts` (the vocabulary it declares), `classify.ts`,
`plugin.ts` and `index.ts`, plus `constants.ts` and `imports.ts` (the import gate) where the sibling has them. Copy `package.json`, `tsconfig.json`,
`tsdown.config.ts` and `vitest.config.ts`; rename, reset `version` to `0.0.0`, rewrite `description`
and the README. Then install the sibling's runtime dependencies (`@aburi/types`, plus
`@aburi/plugin-registry` for effects or `@aburi/core` for frameworks) with the CLI, never by editing
versions in:

```bash
pnpm --filter @aburi/<name> add '@aburi/types@workspace:*' '@aburi/plugin-registry@workspace:*'  # effects
pnpm --filter @aburi/<name> add '@aburi/types@workspace:*' '@aburi/core@workspace:*'             # framework
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
- Effects plugins: add the plugin as a devDependency of `@aburi/cli` (the fixture's `aburi.json`
  loads it from there by package name), put calls it models in a new file of the `effects-coverage`
  fixture under `packages/cli/test/e2e/projects` that imports the library, name the plugin in the
  fixture's `aburi.json`, and add its rows to both cases of `effects-coverage.test.ts`: what the scan
  attributes, and the report rows one edit produces. That test is the only one that checks what each
  effects plugin attributes.
- Docs: `docs/guide/supported-stacks.md` and — worth it for anything users will search for — a
  showcase example (see the `add-showcase-example` skill).
- `pnpm changeset` for the new package and every published package you touched.

## First release

The release workflow cannot publish a package npm has never seen. Before the release PR that
versions the new package is merged, the maintainer publishes a `0.0.0` by hand and adds its trusted
publisher (CONTRIBUTING.md, Releases). Say so in the pull request that adds the package.
