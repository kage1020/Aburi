# @aburi/cli

## 0.1.0

### Minor Changes

- 15e3e49: Add the Aburi command-line entry — `@aburi/cli` — that wires `@aburi/config`, `@aburi/core`, `@aburi/diff`, and `@aburi/markdown-projection` into the commands defined in `design/details/cli-spec.md`. Ships with a `bin/aburi.mjs` shim and a testable `runCli(argv)` surface so integration tests can drive the CLI without spawning a subprocess.

  ### Commands
  - **`aburi init`** — autodetect the workspace root and every JS/TS Component, write an `aburi.json` (or `--output <path>`) with the discovered `languages` / `frameworks` / `components`. Refuses to overwrite unless `--force`. `--with-suggestions` appends JSONC install comments (`pnpm add -D @aburi/framework-nestjs`) for every framework that has a first-party plugin.
  - **`aburi scan`** — resolve config → load plugins → run `@aburi/core` `scan` → write `out/aburi.ir.json` + `out/workspace.md` + `out/components/*.md`. Respects `--format json|md|both`, `--no-json` / `--no-md` shortcuts, `--compact`, `--ignore <glob>` (repeatable), `--no-respect-gitignore`, `--no-timestamp`. Parse errors, effect-classify timeouts, and discovery-time skips surface on stderr so a scan that silently ate 50 broken files still leaves a visible signal.
  - **`aburi diff`** — two dispatch paths (§6):
    - `<base>..<head>` — `git rev-parse --verify` is run against BOTH refs (a mistyped head no longer silently degrades to a "current tree vs base" diff), the shallow-repository guard fires, then `git worktree add --detach` materialises the base and `runScan` executes inside it. The head is always scanned from the working tree (the head ref label is used only for the report). Cleanup runs in `finally`, and every intermediate scan output lives under `mkdtemp` so the user's repo stays clean even if the run aborts. Rename collection failures warn on stderr instead of silently degrading `moved` results into `removed + added` pairs. A missing `git` binary produces a distinct install-git error instead of the "ref not found" false alarm.
    - `--base <ir.json> --head <ir.json>` — parses two IR files and jumps straight into `buildDiff`.
  - **`aburi explain`** — three-arm dispatch (§7.2): full Symbol id (contains `#`) → direct lookup, file path (contains `/`, exists on disk) → all Symbols in the file, otherwise → case-sensitive substring match on `Symbol.name`. Ambiguous substring hits exit 2 with the candidate list on stdout.

  ### `--fail-on` CI gate

  Comma-separated clause list supporting every taxonomy the design (§6.7) calls out:

  - Status tokens: `added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled`.
  - Direction subtypes: `dropped-toggled:to-dropped` / `dropped-toggled:to-kept`.
  - Delta axes: `api-changed` / `logic-changed` / `syntax-changed`.
  - Optional threshold: `<token>:>N` fires only when observed count exceeds `N` (strict `>` semantics; other comparators reserved for a future extension).

  The parser is exhaustive — unknown tokens, unsupported comparators, non-integer / negative thresholds, and an **empty** `--fail-on` value (from an unset shell variable) all throw `FailOnParseError`. A silently-empty gate would let regressions through with a green exit code, so `--fail-on ""` is treated as a configuration mistake, not "gate disabled". `FailOnParseError` maps to `EXIT.INPUT_ERROR` (not runtime) so a grammar typo does not masquerade as a runtime bug. Evaluation returns the first triggered clause so the CI log stays tight; a triggered clause maps to `EXIT.GATE`.

  ### Exit codes (§9)

  `EXIT.SUCCESS (0)` / `EXIT.RUNTIME (1)` / `EXIT.INPUT_ERROR (2)` / `EXIT.GATE (3)`. `CliError` carries a code that the driver maps to one of these; `commander`'s help / version paths are pinned to `SUCCESS`. `runCli()` never calls `process.exit` — it returns the code so the test suite can drive it with captured streams.

  ### Plugin loader

  `loadPlugins({config, workspaceRoot, importModule?, syntheticPlugins?})` resolves every `PluginRef` in `config.{languages,frameworks,effects}`:
  - Bare manifest name (`effects-prisma`) → `@aburi/effects-prisma` package.
  - Scope-prefixed (`@scope/pkg`) or path-like → verbatim package id.
  - Relative (`./plugins/x.mjs`) → resolved against the workspace root as a `file:` URL.

  Each imported module is scanned for a `default` export, then `plugin`, then any top-level export whose value has a `manifest` field with `name` + `type` strings. The routed plugin's declared `manifest.type` must match the bucket it was listed under; a mismatch throws a `CliError("plugin-error")`. Framework-hint synthetic manifests from `@aburi/config` are registered too so hint-declared vocab is available without a physical plugin package.

  ### Public API

  `runCli`, `runInit`, `runScan`, `runDiff`, `runExplain`, `loadPlugins`, `parseFailOn`, `evaluateFailOn`, `evaluateClause`, `formatTriggered`, `readEnv`, `createLogger`, `CliError`, `EXIT`, plus supporting types.

  ### Tests

  46 tests across `test/{env,fail-on,plugin-loader,run,init,diff-fs,explain}.test.ts` cover the CL1..CL18 verifiables reachable without a live plugin runtime: `--version` / `--help` / unknown command routing, argv validation for `aburi diff` (CL10), `--fail-on` grammar and all comparator + status-token combinations, plugin-loader routing / bucketing / mismatches, `init` file-handling (CL4 / CL5), `runDiff` file-mode + `--fail-on` gate → `EXIT.GATE`, `explain` ambiguous substring → `EXIT.INPUT_ERROR` (CL11).

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

- 596a347: Add `@aburi/github-action` — a composite GitHub Action that runs `aburi diff` on a
  pull request and upserts the resulting Markdown as a hidden-marker PR comment.

  ### Runtime shape
  - **Composite action** (`action.yml`). Consumers reference it via
    `uses: kage1020/Aburi/packages/github-action@<tag>`. The `@aburi/cli` binary is
    resolved through `pnpm dlx @aburi/cli@<version>`, so the CLI version is pinned by the
    workflow author rather than the action tag — a policy that lets us ship CLI patches
    without cutting a new action release.
  - **Steps**: input validation (`comment: true` requires markdown output) →
    refspec resolution (input `refspec` overrides; otherwise fall back to
    `pull_request.base.sha..pull_request.head.sha`) → `pnpm/action-setup` +
    `actions/setup-node` → `pnpm dlx @aburi/cli@<version> diff …` → PR-comment upsert
    via `actions/github-script@v7` → CLI exit-code propagation.
  - **Exit-code propagation**: the diff step captures the CLI's status without failing
    the step so the comment upsert can still run when `--fail-on` fired (exit `3`); a
    trailing step then re-exits with the captured code, so a triggered gate fails the
    PR check _and_ leaves the Markdown comment on the PR for the reviewer.
  - **Comment step guard**: the upsert only runs when the CLI exits with `0` (clean) or
    `3` (gate triggered) — the two cases where the CLI actually produced `diff.md`. On
    `1` (runtime) / `2` (input) the comment step is skipped so a missing artefact
    cannot bury the CLI's real failure inside a secondary `ENOENT`.

  ### Artefact filenames

  The action reads `diff.json` / `diff.md` from the CLI output directory. To keep those
  literals in sync with the CLI without silent drift, `@aburi/cli` now exports
  `DIFF_JSON_FILENAME` and `DIFF_MD_FILENAME` from a new `packages/cli/src/artifact-paths.ts`
  module (used by `runDiff` and imported directly by the action's parity test). Renaming
  either artefact on the CLI side now fails the github-action test at CI time instead of
  producing a green build that ENOENTs at runtime — this is why the change is packaged
  as a patch bump for `@aburi/cli` as well.

  ### Two comment-upsert implementations, one marker

  The composite action's `github-script` step and the exported `upsertPullRequestComment`
  helper are separate implementations that share the marker string
  `<!-- aburi:diff-comment -->` — a test asserts that the marker literal is identical in
  `src/comment.ts` and `action.yml`. The action step uses `github.paginate` from octokit;
  the helper uses raw `fetch` with GHES support. Neither invokes the other:

  - **`action.yml` github-script step (runtime)** — the code that actually runs inside
    the workflow. Uses `github.paginate` to walk the PR comment list, matches by marker,
    short-circuits on byte-equal body, otherwise PATCHes or POSTs. Not directly unit-testable;
    the manifest test proves the step is wired correctly (guarded by
    `inputs.comment == 'true'` + exit code, embeds the shared marker literal).
  - **`src/comment.ts` (`upsertPullRequestComment`, programmatic API)** — an exported
    library helper for callers who want to post Aburi-style diff comments outside the
    composite action (bespoke workflows, downstream tools). Uses raw `fetch` with an
    injectable `apiBase` for GitHub Enterprise Server. `buildApiUrl` normalises the base
    so a `/api/v3` mount path is preserved (a naïve `new URL(absolute, base)` would drop it).
    Full fake-fetch coverage in `test/comment.test.ts`.

  ### Silent failure eradication
  - **Byte-equal short-circuit**: when the existing comment body already matches, the
    action returns `unchanged` and skips the PATCH request — no notification bump on
    no-op re-runs.
  - **API errors are loud**: every non-2xx response from the GitHub REST API throws with
    the operation label, status code, and a 400-char response snippet — a token scope
    typo is loud rather than silent-drop-then-green.
  - **Non-array list response** (contract violation from the API) throws instead of being
    treated as "no comments".
  - **Missing `id`/`body`/`html_url`** in a create/patch response throws instead of
    writing back an invalid outcome record.

  ### Public API

  `upsertPullRequestComment`, `ensureMarker`, `ABURI_COMMENT_MARKER`, and the option /
  outcome types are re-exported from `@aburi/github-action` for callers who want to post
  Aburi-style diff comments programmatically without invoking the composite action.

  ### Inputs / outputs

  Inputs: `version` (default `latest`), `refspec`, `fail-on`, `config`, `output-dir`
  (default `out`), `format` (default `both`), `working-directory`, `comment`
  (default `true`), `token` (default `${{ github.token }}`), `node-version`
  (default `24`), `pnpm-version` (default `10`). Outputs: `diff-json-path`,
  `diff-md-path`, `cli-exit-code` (`0` clean / `1` runtime / `2` input / `3` gate or
  plugin — matches `packages/cli/src/exit-codes.ts`), `comment-id`, `comment-action`
  (`created` / `updated` / `unchanged`).

  ### Tests
  - `test/comment.test.ts` (14): `upsertPullRequestComment` create / update / unchanged
    / pagination / GET-error / POST-error / PATCH-error / null-body responses on POST +
    PATCH / bearer token / GHES apiBase / non-array response rejection.
  - `test/action-yml.test.ts` (12): required inputs and defaults, `pnpm dlx` command
    shape, comment step guarded by `inputs.comment == 'true'` + `cli-exit-code`, marker
    parity between YAML and `comment.ts`, exit-code propagation step, output
    declarations, refspec fallback rejecting non-PR events, `comment=true + format=json`
    validation, filename parity with `DIFF_JSON_FILENAME` / `DIFF_MD_FILENAME` from
    `@aburi/cli` (so a CLI-side rename fails here), exit-code table wording.

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
- Updated dependencies [0445f93]
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [121c177]
- Updated dependencies [7a6cfeb]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/plugin-registry@0.1.0
  - @aburi/config@0.1.0
  - @aburi/core@0.1.0
  - @aburi/diff@0.1.0
  - @aburi/markdown-projection@0.1.0
