# @aburi/effects-nest

## 0.1.0

### Minor Changes

- 2973167: Introduce `@aburi/effects-nest`, the NestJS effects plugin. Recognizes `<...>.<eventBus|EventEmitter2>.emit(...)` call expressions and classifies them into the core `event.publish` effect vocabulary.

  ### Recognition strategy (two-signal defense)

  Both signals must be present before an effect is emitted:

  1. The file must import a recognized event-emitter module — `@nestjs/event-emitter` (the NestJS wrapper) or `eventemitter2` (the underlying library). Node's built-in `events` module is intentionally excluded because its per-instance state and stream-oriented `emit` calls do not fit the domain-event vocabulary.
  2. The trailing two segments of the target must be `<name>.emit` where `<name>` is one of the two recognized identifiers (`eventBus` — the conventional DI'd name — or `EventEmitter2` — the class itself). The name hint stops arbitrary `.emit(...)` calls on sockets, streams, and user-named helpers from false-classifying even when the file legitimately imports the emitter module.

  Leading segments are irrelevant — `eventBus.emit`, `this.eventBus.emit`, and `container.services.eventBus.emit` all classify identically.

  ### Effect id and derivedBy
  - `effectId: "event.publish"` — core-owned vocabulary per extension-vocab.md §5.1, not declared in the manifest.
  - `derivedBy: "effects-plugin:nest:<name>.emit"` — plugin-scoped rationale. `EFFECTS_NEST_DERIVED_BY_PREFIX` const is shared between the classifier's tag builder and the manifest's `derivedByPrefixes` entry so drift is impossible.

  ### Malformed input fail-fast

  Empty targets, leading / trailing dots, and adjacent dots are language-plugin contract violations. The classifier throws instead of silently returning null or false-classifying — otherwise `eventBus..emit` would slip through the name gate.

  ### Manifest

  `type: "effects"` with `xPrefix` deriving to `"nest"`. `derivedByPrefixes: ["effects-plugin:nest"]`. Everything else empty (no v0.1 `x-nest:*` bindings, no frameworks or extKinds — those sit in `@aburi/framework-nestjs`).

  The plugin does NOT declare `dropCallees`: NestJS's built-in `Logger` from `@nestjs/common` is DI'd per-provider, so a general prefix drop would sweep too widely (per effect-plugin.md §9.2).

  ### Public API

  `nestEffectsPlugin` (ready-to-register instance), `NestEffectsPlugin` (class), `classifyNestCall`, `hasNestEmitterImport`, `effectsNestManifest`, identifier vocabulary (`NEST_EVENT_EMITTER_IDENTIFIERS`, `NEST_EMIT_METHOD`) with `is*` guards, plus types `NestEventEmitterIdentifier`, `NestEmitMethod`.

  ### Purity

  `classify()` is a pure lookup — no I/O, no state, no async — matching the per-call timeout budget the core enforces (effect-plugin.md §5.1.1). Repeated invocations against the same CallCandidate produce identical results.

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
