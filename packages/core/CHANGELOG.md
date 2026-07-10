# @aburi/core

## 0.1.0

### Minor Changes

- 8510fb1: Introduce the `@aburi/core` foundation package. Bundles the five primitives the extraction pipeline will sit on top of:

  - **Symbol ID generator** — composes `<language>:<file>#<qualified-name>` deterministically, refuses anonymous position-dependent qualified names (the `<anon@L42>` family), refuses Windows backslashes / absolute paths / `..` ascents, and reserves `<default>` as the sole sentinel for unnamed default exports.
  - **Canonical JSON serializer** — NFC-normalizes every string, sorts object keys by Unicode codepoint, preserves array order, and throws `non-plain-json` on functions / symbols / bigint / Map / Set / Date / class instances so silent coercion cannot corrupt downstream fingerprints. Supports `pretty` (2-space indent + LF) and `compact` modes.
  - **IR integrity checker** — runs the 11 invariants enumerated in the IR schema in one pass (uniqueness, referential integrity, conditional shape, enum membership, extKind pattern, POSIX paths, array sort order), returns every violation as a structured list, and offers a throwing variant that aggregates them into one `CoreError`.
  - **Workspace root + manager detection** — walks parents to find the outermost workspace marker (`.git`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, workspace-aware `package.json` / `Cargo.toml` / `pyproject.toml`), then resolves pnpm / npm / yarn / bun / turbo / nx into `WorkspaceManager[]` and a flat candidate list.
  - **Component autodetect (JS/TS)** — derives one `Component` per workspace candidate (id from `package.json#name`, name kept verbatim, languages from depth-3 extension frequency, frameworks from dependency manifests, publicApi from `exports` / `main` / `module` / `types`), resolves id collisions via parent-directory suffixes, and falls back to a single-project Component when no manager fires.

  Public API: `makeSymbolId` / `makeMemberQname` / `makeNestedQname` / `makeTopLevelQname` / `toPosixRelative` / `DEFAULT_EXPORT_QNAME` / `isDefaultExportQname`, `serializeCanonical`, `checkIRIntegrity` / `assertIRIntegrity`, `detectWorkspaceRoot` / `detectManagers`, `detectComponents`, plus `CoreError` with discriminated codes (`anonymous-symbol-id-attempted` / `non-posix-path` / `invalid-language-id` / `non-plain-json` / `integrity-violation` / `workspace-root-not-found` / `workspace-manifest-malformed`).

- 969c4eb: Add the fingerprint module (`@aburi/core/fingerprint`). Computes the three axes of `Symbol.fingerprint` per the design contract: `api` (declaration facets + decorators sorted by name/line + type-only signature shape, deliberately excluding `Symbol.language` and the class-scope prefix of `Symbol.name`), `logic` (rules in source order + effects by `target` only, ignoring `Effect.id` so plugin-classification churn does not perturb the hash), and `syntax` (SHA-256 over a language-plugin-supplied normalized AST string).

  Every axis returns 12 lowercase hex characters (SHA-256 truncated to the first 6 bytes); every string field is NFC-normalized and whitespace-collapsed before hashing; the canonical JSON serializer from `@aburi/core` provides the deterministic byte input. Dropped Symbols short-circuit to `ZERO_FINGERPRINT` (`"000000000000"`) on every axis so cross-IR comparisons treat them as unchanged.

  Public API: `apiFingerprint`, `logicFingerprint`, `syntaxFingerprint`, `computeSymbolFingerprint` (all-axes orchestrator with `dropped` short-circuit), `hashCanonicalObject`, `hashRawString`, `lastQnameSegment`, `normalizeFingerprintString`, `ZERO_FINGERPRINT`, plus `ComputeFingerprintOptions`.

- f8598d1: Add the scan orchestration layer under `packages/core/src/scan/` — the wire that turns a workspace + configured plugin set into a canonical IR. Delivers the full scan-orchestration contract end-to-end:

  - **File discovery** (`discoverFiles`) — glob-driven, respects the core Category A ignore set (`node_modules/`, `dist/`, `*.d.ts`, snapshots, framework caches …), `config.ignore[]`, `.gitignore` (togglable via `respectGitignore`), language-plugin `fileDropPatterns`, and `config.maxFileSizeBytes` with a 2 MiB default. Returned paths are POSIX-relative to the workspace root and sorted asciibetically for determinism.
  - **Language routing** (`buildLanguageRouter`) — case-insensitive extension → LanguagePlugin dispatch. Extension collisions across two plugins throw at build time with a `CoreError("language-routing-collision")`.
  - **Soft classify timeout** (`classifyWithTimeout`) — wall-clock enforcement around `EffectPlugin.classify`. Timeouts return `null` (the next plugin gets a chance) and fire an `onTimeout` hook that populates `stats.effectClassifyTimeouts[]`. A classifier that violates the sync contract by returning a Promise is treated as a timeout instead of stalling the scan.
  - **Category B drop** (`decideSymbolDrop`) — interface / type-alias / empty function body / re-export marker. A boundary decorator always overrides the shape rule.
  - **Category C drop** (`buildDropCFilter`) — core `console.*` / `process.std{out,err}.write` prefixes, `config.suppress[]` additions, effect-plugin `dropCallees[]` additions, `config.keep[]` exceptions. Precedence: keep > suppress > core / plugin. Prefix matching honors identifier boundaries (`console` does not match `consoleWrap`).
  - **Per-file pipeline** (`runFilePipeline`) — parse → extractSymbols → framework classifySymbol (first-match-wins, merges extKind + decoratorBoundaries + derivedBy) → drop-B check → walkBody → drop-C call filter → effect classifySymbol (first-match-wins with timeout) → normalizeAst → `computeSymbolFingerprint`. Dropped Symbols carry `dropped: true` + `dropReason` and receive the ZERO fingerprint on every axis.
  - **Top-level scan** (`scan`) — assembles the IR (Symbols + Components + Dependencies + Stats + Workspace + Generator + Plugins), sorts every array per the schema's ordering rules, and runs `assertIRIntegrity`. The 11 invariants pass before the IR is handed back to the caller.
  - **Canonical output** (`writeCanonicalIR`) — writes the IR to `<output-dir>/aburi.ir.json` via `serializeCanonical`, so the file is byte-stable across runs.

  ### Public API

  `scan`, `writeCanonicalIR`, `discoverFiles`, `buildLanguageRouter` / `LanguageRouter`, `buildDropCFilter` / `DropCFilter`, `decideSymbolDrop`, `runFilePipeline`, `classifyWithTimeout`, plus supporting types (`ScanInput`, `ScanResult`, `DiscoverOptions`, `DiscoverResult`, `FilePipelineInput`, `FilePipelineResult`, `ClassifyTimeoutEvent`, `ClassifyWithTimeoutOptions`, `DropCFilterInput`) and constants (`DEFAULT_MAX_FILE_SIZE_BYTES`, `DEFAULT_CLASSIFY_TIMEOUT_MS`, `CLASSIFY_TIMEOUT_MIN_MS`, `CLASSIFY_TIMEOUT_MAX_MS`).

  Two new `CoreError` codes: `language-routing-collision`, `scan-plugin-misconfigured`.

  ### Tests

  38 new unit tests across `test/scan/{discover,route,drop-b,drop-c,timeout}.test.ts` cover every leaf module. End-to-end coverage lives in a new `@aburi/scan-e2e` private package with 7 tests that drive the full pipeline through the real `@aburi/lang-typescript`, `@aburi/framework-next`, and `@aburi/effects-prisma` plugins — the e2e package is a separate workspace to keep `@aburi/core`'s build graph acyclic.

- 358f76f: Cut the initial `0.1.0` release of the Aburi ecosystem.

  This is the first public version of every workspace package that ships. The
  v0.1 scope defined in [`docs/roadmap.md`](https://github.com/kage1020/Aburi/blob/main/docs/roadmap.md)
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

- 115be7a: Add `fixtures/nestjs-billing/` + `packages/e2e-integration` — the end-to-end suite
  for the v0.1 release.

  ### Fixture

  `fixtures/nestjs-billing/` is a handwritten NestJS-shaped billing service (10 `.ts`
  files under `src/`, two modules × controller × service, one DTO, a shared logger).
  Structured to exercise every axis the diff engine care about: 6 boundary-decorated
  route handlers, 3 `@Injectable()` providers with real method bodies, module classes,
  and a service (`BillingService`) with 12 non-boundary methods that scenario B mutates
  into empty bodies. TS type correctness is deliberately loose in the mutations —
  Aburi parses via tree-sitter and never invokes tsc, so `void`-return bodies on
  methods declared to return an object are fine as scanner input.

  ### Test package

  `packages/e2e-integration` is a private test package. It drives `runInit` from the
  CLI directly (autodetect exercises no plugin resolution), then drives the scan +
  diff paths via `@aburi/core` `scan` + `@aburi/diff` `buildDiff` with workspace
  plugins imported as ES modules — bypassing `runScan`'s `pnpm dlx` plugin
  resolution because the fixture is copied to a bare tmpdir without `node_modules`.
  Plugin-name resolution is already covered by `packages/cli/test/plugin-loader.test.ts`,
  so this suite focuses on integration correctness of the scan → diff pipeline
  end-to-end.

  Snapshots are structural (component/route counts, per-status distribution, gate
  outcome) rather than byte-exact — a full IR snapshot would rot on every plugin
  tweak.

  ### Scenarios
  - **Init** (4 tests): autodetect lands on 1 component with `ts` + `nestjs`, writes
    `aburi.json` with the schema URL, refuses to overwrite without `--force`, honours
    `--force`.
  - **Scan** (5 tests): every source file is discovered (no discovery-time skips),
    IR integrity passes, controllers land under `framework:nestjs:controller` with
    boundary routes, services under `framework:nestjs:provider` with all methods
    kept, modules under `framework:nestjs:module`.
  - **Diff scenario A** — a single `throw` added to `BillingService.applyRefund`.
    Two `changed` Symbols surface (the method itself and the enclosing class whose
    fingerprint mixes member ASTs), `--fail-on changed` trips.
  - **Diff scenario B** — every `BillingService` method body reduced to `{}`. Eleven+
    `dropped-toggled:to-dropped` changes fire (`empty body` drop hint per
    `lang-typescript` drop-hints), `--fail-on dropped-toggled:to-dropped:>10` trips.
    An earlier draft expected "exit 1", which pre-dates the CLI exit-code table; the
    test asserts against the settled contract (`EXIT.GATE = 3`).
  - **Diff scenario C** — `common/logger.service.ts` moves under `common/logging/`
    with importer paths updated. Stage-3 logic-fingerprint matching pairs the moved
    Symbols: `moved > 0`, `added/removed/droppedToggled = 0`, and
    `--fail-on removed,dropped-toggled` does NOT trip.

  ### `@aburi/core` bug fix (patch)

  Building the e2e suite uncovered a real integrity violation in `buildKeptSymbol`
  (`packages/core/src/scan/pipeline.ts`): only `rules[]` was line-sorted before
  entering the IR, while `decorators[]` / `effects[]` / `calls[]` were kept in
  their producer's order. That order comes from either language-plugin AST
  traversal (which is _usually_ source order but not contractually guaranteed)
  or `classifyCalls`'s `byTargetThenLine` (which prioritises target-alpha and
  disregards line). Both violate IR invariant #11 (`decorators/rules/effects/calls[].line`
  monotonic — `integrity.ts:284-311`) the moment a Symbol has two entries whose
  producer-order disagrees with source order.

  The BillingService methods were the first surface long enough to trigger the
  `calls[]` failure; earlier unit tests happened to pass because their method
  bodies had ≤ 1 call. The `effects[]` and `decorators[]` siblings shared the
  same latent bug — surfaced by PR review — and would trip any Symbol that
  classified two effects with target-alpha vs source-line disagreement.

  Fixed in one place: `buildKeptSymbol` now stable-line-sorts all four arrays.
  Same-line entries retain their producer order (schema §17 phrases the
  same-line contract as "appearance order"; JavaScript's stable sort preserves
  that). A caveat: for `effects[]` / `calls[]` the "producer order" is
  `byTargetThenLine`'s output, so same-line entries land in target-alpha order
  rather than tree-sitter emission order — the integrity check only asserts
  line monotonicity, so this is a documented deviation from the strictest
  reading of §17, not a runtime issue.

  Guards: 4 new unit tests in `packages/core/test/scan/pipeline.test.ts` cover
  calls / effects / decorators reverse-line-order inputs plus same-line stable
  sort. Written against `runFilePipeline` so a regression fires here — long
  before the fixture-level integration test does.

  ### Tooling
  - `biome.json` — `!fixtures` added to `files.includes`. Fixture source is
    intentionally shaped (unused decorator-consumed parameters, non-`import type`
    refs) and must not be judged against production lint rules.

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
