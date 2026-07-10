# @aburi/markdown-projection

## 0.1.0

### Minor Changes

- 7a6cfeb: Add the deterministic Markdown projection engine — `@aburi/markdown-projection` — that turns any `aburi.ir.v1` document (and, optionally, an `aburi.diff.v1` output) into human + AI-readable Markdown views, following `design/details/markdown-projection.md` end to end.

  ### Projections
  - **`projectWorkspace(ir)`** (§4 — `workspace.md`) — Managers / Languages / Symbol counts header, Components table (with per-component symbol counts), `graph LR` mermaid dependency diagram with an always-attached text fallback and a `MERMAID_NODE_LIMIT` (100) auto-fallback for oversized graphs, and the top-`EFFECT_SURFACE_TOP_N` (10) effect surface table sorted by count.
  - **`projectComponent({component, symbols, dependencies})`** (§5 — `components/<id>.md`) — Component header (Roots / Languages / Frameworks / Symbols counts), Public API list, Dependencies list, `## Symbols` grouped by file with §3.2 ordering (`startLine` primary, `id` tiebreaker), and a `## Dropped` `<details>` fold-out (§3.6). §5.3 section-omit rules are applied: empty `decorators` / `signature: null` / empty `rules|effects|calls` skip the row, zero fingerprints skip the `<sub>` line.
  - **`projectSymbolExplain(symbol)`** (§7 — `aburi explain`) — Stand-alone Symbol view with dedicated `## Boundary` / `## Decorators` / `## Signature` / `## Rules` / `## Effects` / `## Calls` / `## Derived by` / `## Fingerprint` sections. Dropped Symbols fall back to a 3-line summary (name + drop reason + IR-contract note).
  - **`projectDiff(diff)`** (§6 — `diff.md`) — Ten sections in importance order: `## ⚠ API 変更` / `## 🔧 Logic 変更` / `## ➕ Added` / `## ➖ Removed` / `## 🔀 Moved + Changed` / `## 🔀 Moved` (fold-out) / `## 🧱 Component changes` / `## 🔗 Dependency changes` / `## 💧 Dropped 変動` (fold-out) / `## 🎨 Syntax-only 変更` (fold-out). Changed entries are routed by delta priority (`apiChanged` > `logicChanged` > `syntaxChanged`) into exactly one of the top three sections; `moved+changed` entries are surfaced both under `Moved + Changed` and their delta-priority section by design (§6.2), so a reviewer can see the move context and the impact simultaneously. Empty sections are dropped entirely so PR comments stay tight.
  - **`projectDiffSummaryLine(diff)`** (§6.3) — Compact `+A -R ~C ↔M ⤴MC` string for CLI stdout.

  ### Confidence badges & shared formatters
  - `confidenceBadge` (§3.5) — `high` → no badge, `medium` / `low` → `⚠ <level>`.
  - `signatureLine`, `ruleRow` (§5.6 seven RuleType shapes), `effectRow` (§5.7), `callRow` (§5.8), `fingerprintLine` (§5.9), `decoratorRows` (§5.4), `codeFragment` (§3.4 inline vs. fenced) — pure text primitives reusable across projections.

  ### Sanitisation (§8)
  - `sanitizeSymbolId(id)` — `:` / `/` / `#` / `.` → `-`, consecutive dashes collapse, leading/trailing dashes trim.
  - `collisionSuffix(id)` — deterministic `SHA-256(UTF-8(id))` first 3 bytes as 6-char hex.
  - `withCollisionSuffix(id)` — always-append form.
  - `assignSymbolFilenames(ids)` — batch resolver: keeps base names on unique inputs, appends `-<hash>` to both sides of a collision.

  ### `--fail-on` formatter
  - `FailOnClause` — discriminated union `{kind: "bare"} | {kind: "threshold", comparator, count}` so a threshold clause cannot be constructed with only half its shape. Sub-directions `dropped-toggled:to-dropped` / `dropped-toggled:to-kept` are supported.
  - `formatFailOnClause` → argument-form string (`changed:>10`).
  - `formatFailOnTriggered(clause, observed)` → stable CI-log phrasing.
  - `evaluateFailOn(clause, summary, breakdown?)` → `{triggered, observed}` with strict `>` / `>=` / `==` / `<=` semantics.

  ### Tests

  37 tests across `test/{mp-properties, sanitize, fail-on}.test.ts` cover MP1..MP12 verifiables, sanitisation + collision (MP9), and every `--fail-on` comparator / bare-status combination.

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

- 405dcfa: Ship the v0.1 documentation set.

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
    `@aburi/github-action` already had one and is untouched.
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
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
