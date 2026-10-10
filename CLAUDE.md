# Aburi

Semantic IR extraction for code review: `aburi scan` turns a TypeScript/JavaScript workspace into one JSON
document (the IR), `aburi diff` compares two of them and renders a Markdown report a CI can gate on.
Architecture: `docs/extend/architecture.md`. Contracts: `docs/design/*.md` and the JSON Schemas in `schema/`.

## Commands

```bash
pnpm install
pnpm check                       # Biome; `pnpm format` writes the fixes
pnpm hygiene                     # no citations of design docs, spec ids or issues (CI runs it)
pnpm typecheck | test | build    # turbo across the workspace
pnpm turbo run test --filter=@aburi/core --force   # one package, deps built first, cache bypassed
cd packages/<name> && pnpm exec vitest run [file]  # fastest loop; see the note below
```

Turbo prints a task's log only on failure and vitest prints console output only for failing tests, so a
green run is a few summary lines. Turbo replays cached results: verify with `--force` and check the footer
says `Cached: 0 cached`. The `verify` skill has the full routine.

A suite imports its own package's `src`, every other published `@aburi/*` package through its built `dist`
(rebuild it before trusting a direct vitest run), and `@aburi/schema`, `@aburi/test-support` and
`@aburi/test-harness` from source — those three never need a build.

## Layout and dependency direction

```
@aburi/types ─┬─ @aburi/plugin-registry ── @aburi/config
              ├─ @aburi/core ─┬─ @aburi/lang-typescript
              │               ├─ @aburi/framework-*   (framework-nestjs also uses plugin-registry)
              │               └─ @aburi/diff
              ├─ @aburi/effects-*            (types + plugin-registry)
              └─ @aburi/markdown-projection
@aburi/cli ── config, core, diff, markdown-projection, plugin-registry   (loads plugins at runtime)
@aburi/github-action ── runs the CLI
```

Private packages:

- `@aburi/schema` (`schema/`) — the JSON Schemas. Import them by name
  (`@aburi/schema/aburi.ir.v1.json`), never by walking up the tree. `v1` is frozen: additive changes only.
- `@aburi/test-support` — helpers every suite may use: IR and diff builders (`makeIR`, `makeSymbol`,
  `makeDiff`, `changed`, …), plugin contexts and candidates (`makeCtx`, `makeCandidate`, `importEdge`),
  `noopRegistry`, `recordingLogger`, `useScratchWorkspace`, `errorFrom`, `symbolById`,
  `irSchemaViolations`. Depends on nothing above `@aburi/types`.
- `@aburi/test-harness` — the real pipeline for suites: `scanWith` (scan over a plugin lineup), `diffIRs`,
  `diffOfEditWith` (scan, edit, rescan, diff), `extractFile`, `classifyInputsAround`. It depends on core,
  diff, plugin-registry and test-support and never on a plugin (plugins are passed in), so the plugins,
  lang-typescript and the CLI may devDepend on it; core, diff, plugin-registry and test-support may not.
- `@aburi/examples` (`examples/`) — the docs Showcase; its build runs `aburi diff` over each example.
- `@aburi/docs` (`docs/`) — the VitePress site. Its `build` builds the packages it renders first.
- `@aburi/benchmark-public-repos` (`benchmarks/public-repos/`) — measures `scan` and `diff` on pinned
  public repositories; run by hand or by `benchmark.yml`, not by turbo's build.

Generated, gitignored, rebuilt by turbo: `packages/types/src/generated/` (the `codegen` task, from the
schemas) and `packages/lang-typescript/wasm/` (vendored grammars).

## Where a test goes

A test lives in the package whose behaviour it pins and depends only on what it needs. Single-plugin scans
live in that plugin; TypeScript-only scans and diffs in `lang-typescript`; pipeline runs across several
plugins and the CLI in `packages/cli/test/e2e` (fixture projects in `test/e2e/projects/`). No runtime
dependency reaches every package; `@aburi/cli`'s devDependencies do, because `test/e2e` runs the whole
pipeline, and its tests run against its own built bin.

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
- Branch from `main`; changes land through pull requests.

## Things that are not obvious

- `.gitattributes` forces LF: Biome is configured for LF and Windows checkouts would otherwise fail it.
- `declarationMap` stays off: turning it on makes rolldown-plugin-dts enable sourcemaps for every
  tsdown build and ships ~1.6 MB of `.map` files.
- The docs deploy uses `cloudflare/wrangler-action@v4`; v3 pins a Wrangler that cannot deploy an
  assets-only Worker.
- The docs site ships with a release, not a merge (`release.yml` calls `docs.yml`).
- `packages/github-action/test/resolve-cli-bin.test.ts` › "anchors on the working directory…" fails in
  a long-lived checkout whose pnpm store exposes `@aburi/cli` through vitest's `NODE_PATH`; it passes in a
  fresh install and in CI.
- Workflow settings that look like oversights (no `registry-url`, a constant docs concurrency group,
  `fetch-depth: 0`) carry a one-line reason beside them; npm's trusted-publisher setup is in
  `CONTRIBUTING.md`.

## Skills

`verify` (the checks), `code-hygiene` (duplicates, redundant tests, rotting references),
`new-plugin`, `add-showcase-example`.
