---
"@aburi/cli": minor
"@aburi/config": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/effects-nest": minor
"@aburi/effects-prisma": minor
"@aburi/framework-nestjs": minor
"@aburi/framework-next": minor
"@aburi/github-action": minor
"@aburi/lang-typescript": minor
"@aburi/markdown-projection": minor
"@aburi/plugin-registry": minor
"@aburi/types": minor
---

Cut the initial `0.1.0` release of the Aburi ecosystem.

This is the first public version of every workspace package that ships. The
v0.1 scope defined in `design/roadmap.md` is complete:

- **Foundation** — `@aburi/types` (schema-generated + hand-written interfaces),
  `@aburi/plugin-registry` (vocab registry + conflict enforcement),
  `@aburi/config` (JSONC + ajv-validated loader with framework-hint
  normalisation), `@aburi/core` (Symbol id, canonical JSON, 11 IR invariants,
  autodetect, scan orchestration).
- **Language** — `@aburi/lang-typescript` (tree-sitter WASM TS/TSX plugin).
- **Frameworks** — `@aburi/framework-nestjs`, `@aburi/framework-next`.
- **Effects** — `@aburi/effects-prisma`, `@aburi/effects-nest`.
- **Diff + projection** — `@aburi/diff` (5-stage semantic matcher +
  status + delta), `@aburi/markdown-projection` (workspace / component / diff
  / explain views).
- **Delivery** — `@aburi/cli` (`aburi init | scan | diff | explain`, exit codes
  0 / 1 / 2 / 3, `--fail-on` gate), `@aburi/github-action` (composite action +
  marker-based PR comment upsert).

### Publishing pipeline

- `.github/workflows/ci.yml` — matrix (ubuntu / macos / windows) runs
  `check`, `typecheck`, `build`, `test` on every PR + push to `main`.
- `.github/workflows/release.yml` — on merge to `main`,
  `changesets/action@v1` either opens a "Version Packages" PR (when there are
  pending changesets) or, if the previous run already merged such a PR, runs
  `pnpm changeset publish --no-git-tag` to push every bumped package to npm
  under `--provenance` via GitHub OIDC (`NPM_CONFIG_PROVENANCE=true`).
- Every public package.json now carries `repository.directory` so npm links
  back to the correct monorepo subdirectory, plus explicit `author`,
  `homepage`, and `bugs` fields.

### Consumer entry points at 0.1.0

- `npm i -D @aburi/cli @aburi/lang-typescript @aburi/framework-<yours>`
  (see the [root README](../README.md) for the quick start).
- `uses: kage1020/Aburi/packages/github-action@v0.1.0` in a workflow to gate
  PRs on the semantic diff.

The action is referenced by repo path (composite action convention) and the
CLI version it invokes is picked by the workflow author via the `version`
input, so future CLI patch releases roll out to consumers without a fresh
action tag.
