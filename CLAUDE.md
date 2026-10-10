# Aburi

Semantic IR extraction for code review: `aburi scan` turns a TypeScript/JavaScript workspace into one JSON
document (the IR), `aburi diff` compares two of them and renders a Markdown report a CI can gate on.
Architecture: `docs/extend/architecture.md`. Contracts: `docs/design/*.md` and the JSON Schemas in `schema/`.

## Commands

```bash
pnpm install
pnpm check                       # Biome; `pnpm format` writes the fixes
pnpm typecheck | test | build    # turbo across the workspace
pnpm turbo run test --filter=@aburi/core --force   # one package, deps built first, cache bypassed
cd packages/<name> && pnpm exec vitest run [file]  # fastest loop; other packages resolve via their dist
```

Turbo prints a task's log only on failure and vitest prints console output only for failing tests, so a
green run is a few summary lines. Turbo replays cached results: verify with `--force` and check the footer
says `Cached: 0 cached`. The `verify` skill has the full routine.

## Layout and dependency direction

```
@aburi/types ─┬─ @aburi/plugin-registry ── @aburi/config
              ├─ @aburi/core ─┬─ @aburi/lang-typescript
              │               ├─ @aburi/framework-*
              │               └─ @aburi/diff
              ├─ @aburi/effects-*            (types + plugin-registry)
              └─ @aburi/markdown-projection
@aburi/cli ── config, core, diff, markdown-projection, plugin-registry   (loads plugins at runtime)
@aburi/github-action ── runs the CLI
```

Private packages:

- `@aburi/schema` (`schema/`) — the JSON Schemas. Import them by name
  (`@aburi/schema/aburi.ir.v1.json`), never by walking up the tree. `v1` is frozen: additive changes only.
- `@aburi/test-support` — helpers every suite may use: IR builders, plugin contexts, `noopRegistry`,
  `recordingLogger`, `useScratchWorkspace`, `symbolById`, `irSchemaViolations`. Depends on nothing above
  `@aburi/types`.
- `@aburi/test-harness` — `scanWith` (the real scan over a plugin lineup) and `diffIRs`. It depends on core,
  diff and plugin-registry, so only packages above those may use it.
- `@aburi/examples` (`examples/`) — the docs Showcase; its build runs `aburi diff` over each example.
- `@aburi/docs` (`docs/`) — the VitePress site.

Generated, gitignored, rebuilt by turbo: `packages/types/src/generated/` (the `codegen` task, from the
schemas) and `packages/lang-typescript/wasm/` (vendored grammars).

## Where a test goes

A test lives in the package whose behaviour it pins and depends only on what it needs. Single-plugin scans
live in that plugin; TypeScript-only scans and diffs in `lang-typescript`; pipeline runs across several
plugins and the CLI in `packages/cli/test/e2e` (fixture projects in `test/e2e/projects/`). Nothing depends
on every package.

- Pin behaviour, not text: no test reads repository files to check how they are written.
- Use the real pipeline (`scanWith`) instead of re-implementing parse → extract → classify in a test.
- Shared helpers go to `@aburi/test-support` / `@aburi/test-harness`, never copied between suites.
- Near-identical cases become one `it.each` table.
- Scratch directories go under `os.tmpdir()` (`useScratchWorkspace`): config discovery walks up to the
  repository's own `aburi.json`.

## Code conventions

- Code says how. A comment says only the why the code cannot, in a line or two. No what-comments: a
  comment that states behaviour is a test to write. No references that rot — `§` sections, `*.md` files,
  spec ids, invariant numbers, issue or PR numbers — in code, comments or test titles.
- ESM, strict TypeScript, no `any` escapes, no linter-suppression comments.
- Dependencies are added with `pnpm add` (workspace packages as `'@aburi/x@workspace:*'`), never by
  writing versions into `package.json`.
- Behaviour is specified in `docs/design/` first; change the doc and schema in the same branch.
- A change to a published package needs a changeset (`pnpm changeset`).
- Branch from `main`; `main` is protected.

## Things that are not obvious

- `.gitattributes` forces LF: Biome is configured for LF and Windows checkouts would otherwise fail it.
- `declarationMap` stays off: turning it on makes rolldown-plugin-dts enable sourcemaps for every
  tsdown build and ships ~1.6 MB of `.map` files.
- The docs deploy uses `cloudflare/wrangler-action@v4`; v3 pins a Wrangler that cannot deploy an
  assets-only Worker.
- The docs site ships with a release, not a merge (`release.yml` calls `docs.yml`).
- `packages/github-action/test/resolve-cli-bin.test.ts` › "anchors on the working directory…" fails
  locally on every branch (vitest's `NODE_PATH`) and passes in CI.

## Skills

`verify` (the checks), `code-hygiene` (duplicates, redundant tests, rotting references),
`new-plugin`, `add-showcase-example`.
