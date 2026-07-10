# @aburi/diff

## 0.1.0

### Minor Changes

- 121c177: Add the semantic diff engine — `@aburi/diff` — that compares two `aburi.ir.v1` documents and emits an `aburi.diff.v1`-conformant JSON projection tuned for PR-review workflows. Delivers every WI-12 acceptance criterion from `design/details/diff-algorithm.md`.

  ### Matching pipeline (5 stages)
  - **Stage 1 — exact id match** (`matchStageId`) — hash-map lookup; the highest-confidence signal.
  - **Stage 2 — git rename** (`matchStageGitRename`) — rewrites the base id with the head-side file path when a `git diff --find-renames` map is supplied. Missing map (or empty) skips the stage cleanly.
  - **Stage 3 — logic-fingerprint match** (`matchStageLogicFingerprint`) — buckets base by `fingerprint.logic`. Single-candidate hits pair with `logic-fingerprint`; multi-candidate hits fall back to name-similarity disambiguation with a 0.85 floor. Dropped Symbols (zeroed fingerprint) are excluded to prevent the whole population from colliding at `"000000000000"`.
  - **Stage 4 — name + signature similarity** (`matchStageNameSignature`) — `(kind, signatureNullness)` bucket pre-filter; score = `0.5·nameSimilarity + 0.3·signatureSimilarity + 0.2·ownerSimilarity` with kind-aware threshold table (1-token → 1.0, 2-token → 0.95, else 0.85). Both-signatureless pairings are skipped to keep `sig=null+null` from returning 1.0 across the whole class body.
  - **Stage 4.5 — dropped weak matcher** (`matchStageDroppedWeak`) — same-kind fallback for dropped Symbols using `lastSegment(name) + basename(file)`; threshold 0.5 (either half is enough) so directory renames of DTO folders show up as `moved` rather than `droppedRemoved + droppedAdded`.

  ### Delta and status
  - **Status classifier** (`classifyStatus`) — `dropped-toggled` absolutely dominates (§4.1); otherwise path-or-id change and fingerprint change compose into `moved` / `changed` / `moved+changed` / `unchanged`. In-file rename (id changed, path same, fingerprint same) is `moved` per DF9.
  - **Symbol delta** (`computeSymbolDelta`) — three fingerprint booleans + array deltas for rules / effects / calls / decorators with configurable line fuzz (default 2, max 10). Decorator identity is `name`; argument-list differences produce `modified`. Signature delta emits inputs / outputs / throws sub-deltas plus `async` / `generator` / `typeParameters` change flags. Line fuzz is delta-only (fingerprints already exclude line info).
  - **Component diff** (`diffComponents`) — id-keyed, `changed[]` entries carry `rootsChanged` / `publicApiChanged` / `frameworksChanged` booleans (no `modified` per §6.1).
  - **Dependency diff** (`diffDependencies`) — `(from, to, via)` triple key. Direction / effect changes are recorded as an added + removed pair (no `modified` per §6.2).

  ### Public API

  `buildDiff`, `writeCanonicalDiff`, `computeSymbolDelta`, `classifyStatus`, `dropDirection`, `diffComponents`, `diffDependencies`, `matchStage{Id,GitRename,LogicFingerprint,NameSignature,DroppedWeak}`, `nameSimilarity`, `ownerSimilarity`, `signatureSimilarity`, `tokenizeName`, `jaccard`, `lastSegment`, plus supporting types (`DiffInput`, `SymbolPair`, `SymbolStatus`, `DropDirection`, `DeltaOptions`, `GitRenameMap`, `DiffError`, `DiffErrorCode`, `DiffErrorDetail`) and constants (`DEFAULT_LINE_FUZZ`, `MIN_LINE_FUZZ`, `MAX_LINE_FUZZ`).

  Two new `DiffError` codes: `schema-mismatch`, `invalid-line-fuzz`.

  ### Tests

  47 new tests across `test/{df-properties,match,similarity,canonical}.test.ts` cover DF1..DF18 + DF14b (dropped weak match by basename), the 5-stage matcher in isolation, similarity + owner tokenisers, and byte-deterministic canonical output stability.

- 358f76f: Cut the initial `0.1.0` release of the Aburi ecosystem.

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
    - `changeset publish`) to push every bumped package to npm.
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

### Patch Changes

- 405dcfa: Ship the v0.1 documentation set required by WI-17.

  - **Root `README.md`** — rewritten from a status placeholder into a full quick
    start: install / init / scan / diff / GitHub Action, a "why not just `git diff`"
    motivation with the four canonical scenarios, an architecture-at-a-glance
    block that walks source → IR → derived views, and a package matrix pointing
    at every workspace member.
  - **Per-package `README.md`** — 12 new files (`@aburi/types`,
    `@aburi/plugin-registry`, `@aburi/config`, `@aburi/core`,
    `@aburi/lang-typescript`, `@aburi/framework-nestjs`, `@aburi/framework-next`,
    `@aburi/effects-prisma`, `@aburi/effects-nest`, `@aburi/diff`,
    `@aburi/markdown-projection`, `@aburi/cli`). Each covers the pitch, install,
    the shape of the API the package exports, and design-doc references.
    `@aburi/github-action` already had one from WI-15 and is untouched.
  - **`docs/cli-reference.md`** — operator-facing per-subcommand reference for
    `aburi init / scan / diff / explain`: flags, `--fail-on` grammar, exit-code
    table, environment variables, config discovery order, and programmatic entry
    points.
  - **`docs/plugin-development.md`** — walkthrough for authoring `LanguagePlugin`
    / `FrameworkPlugin` / `EffectPlugin`, the manifest contract, the two-signal
    layered gate convention for effect classifiers, testing pattern, and CLI
    loader resolution rules.

  Docs-only change. Patch-bump every public package so the `files: ["dist", "src",
"README.md"]` package.json entry ships the freshly written README when the
  next release is cut.

- Updated dependencies [19f2494]
- Updated dependencies [a8882f0]
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/core@0.1.0
