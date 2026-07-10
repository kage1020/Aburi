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
v0.1 scope defined in [`design/roadmap.md`](https://github.com/kage1020/Aburi/blob/main/design/roadmap.md)
is complete:

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

- `.github/workflows/ci.yml` — matrix (ubuntu / macos / windows) runs Biome
  `check`, `typecheck`, `build`, `test` on every PR and every push to `main`.
- `.github/workflows/release.yml` — on push to `main`, `changesets/action@v1`
  either opens a "Version Packages" PR (when there are pending changesets) or,
  if that PR was already merged, runs `pnpm release` (typecheck + test + build
  + `changeset publish`) to push every bumped package to npm.
- Authentication uses [**npm Trusted Publishing**](https://docs.npmjs.com/trusted-publishers)
  (OIDC). No `NPM_TOKEN` secret is stored anywhere; pnpm 11.11.0 exchanges the
  workflow's OIDC token for a short-lived publish credential at publish time.
  Sigstore attestation is emitted via `provenance=true` in the workflow's
  `.npmrc`, and consumers verify tarballs with `npm audit signatures`.
- `changesets/action` reads the `New tag: …` lines the publish command prints
  and creates a matching GitHub Release per per-package tag
  (`@aburi/<pkg>@0.1.0`).
- Every public package.json carries `repository.directory` so npm links back
  to the correct monorepo subdirectory, plus explicit `author`, `homepage`,
  and `bugs` fields.

### One-time trusted-publisher setup (required before the first publish)

For each of the 13 publishable `@aburi/*` packages, register a trusted
publisher on npmjs.com pointing at this repository's release workflow:

1. On the package settings page (e.g.
   `https://www.npmjs.com/package/@aburi/cli/access` — for a not-yet-published
   package, first do a one-time manual `npm publish` to reserve the name, or
   configure the trusted publisher on the org account before publishing).
2. Under "Trusted Publisher", add:
   - **Provider**: GitHub Actions
   - **Repository**: `kage1020/Aburi`
   - **Workflow filename**: `release.yml`
   - **Environment**: leave blank (no environment gating today)
3. Repeat for all 13 packages, or configure the trusted publisher on the
   `@aburi` org so newly-scoped packages inherit it.

Once configured, no rotation, no secret storage, and no static credential is
ever created. Revoking access is a one-click delete on the npm settings page.

### Consumer entry points at 0.1.0

- `npm i -D @aburi/cli @aburi/lang-typescript @aburi/framework-<yours>`
  (see the [root README](https://github.com/kage1020/Aburi#readme) for the
  quick start).
- `uses: kage1020/Aburi/packages/github-action@main` in a workflow to gate
  PRs on the semantic diff. The action is referenced by repo path (composite
  action convention), and the CLI version it invokes is picked by the workflow
  author via the `version` input, so future CLI patch releases roll out to
  consumers without a fresh action tag. When per-release ref pinning is
  wanted, use the per-package tag `changesets/action` creates
  (`@aburi/github-action@0.1.0`) — an unscoped `v0.1.0` tag is intentionally
  not published because `changeset publish` names monorepo tags per package.
