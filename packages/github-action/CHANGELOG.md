# @aburi/github-action

## 0.3.0

### Minor Changes

- 56a1aad: Give the action a ref that can be pinned immutably.

  `changeset publish` names every monorepo tag after its package, so the only ref a release
  left behind for this action was `@aburi/github-action@<x.y.z>` — a name a `uses:` cannot
  hold. The runner splits a `uses:` value on `@` and rejects anything that is not exactly
  two segments, so `kage1020/Aburi/packages/github-action@@aburi/github-action@0.2.0` fails
  the manifest to load with `Expected format {org}/{repo}[/path]@ref`, before any step runs.
  That left `@main` as the only ref that worked, and `@main` changes under the consumer on
  every merge. The action's own README recommended the per-package tag anyway.

  A new `tag-action` job on the release workflow pushes two refs onto the release commit. They
  are unprefixed — the path in front of them already says which action they belong to, and
  `changeset publish` only ever writes scoped `@aburi/<pkg>@<ver>` tags, so the `v*` namespace
  is this action's alone:

  - `v<x.y.z>`, created once and never re-pointed, so a workflow pinned to it keeps
    running the bytes it was reviewed against. Pushing a tag only fails when it points
    somewhere else — on the same commit git reports `Everything up-to-date` and exits 0 — so
    the job compares the existing tag's commit itself: equal means a retried run and it
    carries on, different is an error naming the repair.
  - `v<major>`, moved to the newest release of this action — the convenience alias,
    documented as mutable. While the major is `0` it crosses breaking input changes, because
    a `0.x` minor bump is where those land. A prerelease keeps its immutable tag and leaves
    the alias alone.

  It is a separate job rather than a step on the publish job so that a tag ruleset or a
  rejected push cannot redden a run in which npm already has the packages, or take the
  `needs: release` docs deploy down with it. Because `changeset publish` skips packages that
  are already published, a re-run reports `published: false` and could never reach the
  tagging again, so the workflow also gains a `workflow_dispatch` that tags a given version
  at the commit its `@aburi/github-action@<version>` tag names — a recovery path that cannot
  start a publish, and does not depend on where `main` has moved since.

  A release that bumps only the CLI or a plugin leaves both tags where they are, pointing at
  the commit whose `action.yml` consumers are still running.

  The READMEs and the CI integration guide gain a Pinning section covering all four refs
  (`v<x.y.z>`, `v<major>`, `main`, a full SHA) and drop the advice that named
  the unusable tag. Their examples move off `@main` onto `@v0`, which this release is
  the first to create; the section says plainly that it crosses breaking input changes while
  the major is `0`, and points anyone who minds at the full `v<x.y.z>`.

  The companion workflow's checkout in the fork hand-off example pins `ref: v0` rather
  than a hard-coded `@aburi/github-action@<x.y.z>`. `changeset version` rewrites `package.json`
  and `CHANGELOG.md` and nothing else, so a version written into README prose goes stale on the
  next release with nothing to catch it; the alias has no version to keep in step.

  `test/uses-refs.test.ts` replays the runner's own parse over every `uses:` in the READMEs,
  the docs and the workflows — both quoting styles and a trailing comment included — so a
  snippet that would fail to load fails CI instead of a consumer's first run. It also pins
  the parse and the allowed-ref pattern with direct cases, checks the documented alias
  against this package's real major (a `major` bump would strand every `@v0` in the
  docs), and asserts the tagging job's gate, its separation from the docs deploy, and the
  glob pattern that keeps the alias off a prerelease.

  `turbo.json` declares the files that test reads as inputs of `@aburi/github-action#test`.
  Without them a local run after editing the root README or the CI guide served a cached
  pass and the new guard never executed; CI is cold every time, so it only ever bit locally.

- aa21622: Run the CLI the project installed, so a config that names a plugin by package has one

  The action resolved `aburi` one way: `pnpm dlx @aburi/cli@<version>`, which installs the CLI into
  the pnpm store rather than into the checkout. The CLI resolves a plugin ref from its own location,
  so `languages: ["lang-typescript"]` — the line `aburi init` writes into every TypeScript workspace
  it detects — resolved from the store copy of `@aburi/cli` and found nothing:

  ```
  Failed to import plugin "lang-typescript" (resolved to "@aburi/lang-typescript"):
  Cannot find package '@aburi/lang-typescript'
  ```

  That is exit 3 before a single file is parsed, and no `pnpm add` in the consumer's project changes
  it, because the consumer's `node_modules` is not on that resolution path. The documented quick
  start installs the CLI and its plugins as devDependencies; the documented action could use neither.
  (A plugin named by relative path was always fine: those resolve against the workspace root.)

  The new `cli` input picks the resolution. `dlx` is the old behaviour and stays the default — it
  needs no install step, and it suits a config that names no plugin by package. `workspace` runs the
  `@aburi/cli` the project installed, resolved from `working-directory`, with the project's plugins
  beside it and the project's lockfile deciding the version. `version`, `node-version` and
  `pnpm-version` do not apply there: the caller installed the workspace with a toolchain of their
  own, and re-running `actions/setup-node` would swap it out from under that install, so the two
  setup steps are skipped as well.

  Resolution goes through Node's resolver — `@aburi/cli`'s manifest, then its `bin.aburi` — rather
  than through a `node_modules/.bin` entry, which npm, yarn and bun projects have no `pnpm exec` to
  reach and a workspace that builds its own CLI does not have at all: the bin file is not there when
  the install writes the links, and no later install recreates it, the tree being up to date by then.
  Yarn PnP is the one arrangement this does not serve, having no `node_modules`; it needs `cli: dlx`.

  The resolver is a script (`scripts/resolve-cli-bin.mjs`) rather than a heredoc, so it is testable
  and tested. It answers with the bin's path, or with one line saying which of three things is wrong:
  `@aburi/cli` is not installed where it looked, the manifest declares no `aburi` command, or the bin
  it names does not exist — the last being a workspace that installed and did not build, which
  otherwise reached the runner as the CLI's own `MODULE_NOT_FOUND` and got reported as a runtime
  error in the analysed project.

  A `cli` value that is neither `dlx` nor `workspace` is exit 2 from the input-validation step, next
  to the `format` check. So is `comment`, now: every value but `true` read as false there, so
  `comment: yes` ran green, posted nothing, and cleared the `comment=true` + `format=json` check on
  the way past.

  `@aburi/github-action`'s contract now has a design doc, `docs/design/github-action.md`.

- 94298bb: Let a fork's pull request get its report, without handing the fork a writable token

  A pull request from a fork runs with a read-only `GITHUB_TOKEN`, and no `permissions:` block
  changes that — the event decides the scope before any step runs. Dependabot's pull requests are the
  same case from the other direction: the branch lives in the repository and passes every `head.repo`
  check, and the token still cannot comment. So the two kinds of pull request that most need the
  report — an outside contribution, and a bump whose effect on the API nobody reads by hand — were
  the two that only ever got a red or green check and an artifact nobody downloads.

  `pull_request_target` is the usual answer and the wrong one here: it would give a writable token to
  a job whose whole purpose is to analyse the head, which on a fork is code the contributor controls.

  The work splits in two instead. The pull request's own run analyses, gates, and uploads `out/` as
  an artifact; a `workflow_run` workflow in the base repository downloads that artifact and posts the
  comment. `.github/workflows/aburi-comment.yml` is this repository's own half of that pair, and
  `docs/design/github-action.md` §5.1 is the contract — including the three things that make the
  privileged half safe: it executes nothing from the head (a sparse checkout of the default branch,
  for one script), the pull request number is resolved from the event rather than read out of the
  artifact (a fork can edit the analysis workflow, and so what it uploads; it cannot edit the head
  repository and branch GitHub recorded for the run), and no artifact content is interpolated into a
  shell.

  Which half comments is decided once, in the analysis job, and travels in the artifact as a
  `comment-pending` file — a second copy of that decision, written against a different event payload,
  is a copy that can disagree, and the way it disagrees is that nobody comments at all. The decision
  is the outcome rather than the permission: the marker is written when the run finished with no
  comment of its own, which covers the upsert that was refused as well as the one that was never
  allowed. The companion says out loud when it stands down, and fails rather than exiting green when
  it has a report and cannot place it — a `workflow_run` workflow posts no check, so a line in a
  collapsed step log is the same as saying nothing.

  The upsert the action runs is now `scripts/upsert-comment.mjs` rather than an inline
  `actions/github-script` block, because the companion workflow runs the same one: one marker string,
  one flow, one set of tests, and no second implementation to keep in step. Behaviour is unchanged —
  find the comment carrying `<!-- aburi:diff-comment -->`, rewrite it in place, report `unchanged`
  when the bytes already match — and the step's `comment-id` and `comment-action` outputs still carry
  the outcome. Input reaches it through the environment only, never argv: on a fork's pull request
  the Markdown names symbols that pull request declares. Exit 2 says the invocation is wrong, exit 1
  that the API refused, each as one `::error::` line.

  The script is plain `.mjs` with no dependencies and is published with the action, so anything with
  Node can post an Aburi comment: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `MARKDOWN_PATH`,
  and `GITHUB_API_URL` for Enterprise Server. `src/comment.ts` remains the library form for callers
  importing the package, and a test pins the two to the same marker.

### Patch Changes

- aa21622: Stop documenting an expression the runner tries to evaluate

  The `refspec` input's description quoted the fallback it documents —
  `${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}` — as prose.
  The runner parses a manifest's descriptions as templates, with a context set that has no `github`
  in it, so loading the action failed before its first step ran:

  ```
  action.yml (Line: 19, Col: 18): Unrecognized named-value: 'github'.
  Located at position 1 within expression: github.event.pull_request.base.sha
  ```

  Every consumer of the action got that, whatever their inputs: the manifest never loaded. The
  description now names those context paths as plain text, and a test asserts that no description
  holds a `${{ … }}` and that no input `default` does either, apart from the `${{ github.token }}`
  every action uses — defaults are template-evaluated in the same way, so the next instance of this
  outage would otherwise be one `default:` away. Nothing else catches it: the manifest is parsed by
  the runner rather than by anything that runs in CI.

  While there: the description also said the fallback applies on `pull_request`, where the step has
  always accepted `pull_request_target` too.

- aa21622: Keep a failing step from taking the gate's verdict down with it

  Three ways the action could fail while saying something other than what happened.

  **A warning could be read as a path.** The workspace resolver's stderr was merged into the captured
  stdout, so anything Node wrote there while still exiting 0 — an `ExperimentalWarning` from the
  caller's `NODE_OPTIONS`, a corepack notice — was prepended to the path and then run as one. The
  result was `Cannot find module '(node:1234) ExperimentalWarning: …'`: exit 1, reported as the
  CLI's runtime error, pointing the reader at the code being analysed. stderr goes to a file now, and
  is quoted back only when the resolve actually failed.

  **A misconfiguration could read as success.** The resolver's failure exits before the step writes
  its outputs, so `cli-exit-code` came back empty rather than `2`. A caller testing
  `cli-exit-code != '0'` passed on the empty string; one writing `cli-exit-code || '0'` read the
  failure as clean. The outputs are written before that exit now, and the output's own description
  says which value means what.

  **A tripped gate could vanish behind an API error.** The step that propagates the CLI's exit code
  had no `if: always()`, and a composite action stops at its first failing step — so a 403 or a rate
  limit while posting the comment ended the job on a GitHub API failure, with `--fail-on` having
  fired and nothing in the log saying so. It runs unconditionally now; an empty exit code, from an
  earlier step failing on its own terms, reads as 0 and leaves that failure standing.

- 155bed3: Ship the packages, not the workshop

  Installing `@aburi/cli` and its dependency closure put 22.08 MB of prebuilt parser binaries
  on disk to read 2.86 MB of them. Nothing in that was deliberate — each piece was a default
  nobody had reason to look at until the sizes were measured side by side. Every number
  below is decimal MB, measured on this branch against its base.

  `@vscode/tree-sitter-wasm` was the bulk of it. It ships sixteen prebuilt grammars totalling
  21.66 MB — bash, C#, C++, Ruby, Rust, PHP, PowerShell and the rest — and
  `@aburi/lang-typescript` loads exactly two of them, `tree-sitter-typescript` and
  `tree-sitter-tsx`, together 2.86 MB. npm cannot install part of a tarball, so every
  consumer paid for the other fourteen, 18.80 MB, to sit on disk unread.

  `scripts/copy-grammars.mjs` now vendors the two we parse with into the package's own
  `wasm/` at build time and the dependency drops to a devDependency, which takes that
  directory from 22.08 MB to 2.86 MB. The copies are byte-identical to the upstream files.
  `wasm/NOTICE` records their provenance and reproduces both the licence text upstream
  distributes and the component registration from its `cgmanifest.json`, and bumping the
  grammars stays an ordinary devDependency bump.

  The rest was the published tarballs. `files` listed `src` beside `dist`, so the TypeScript
  sources shipped a second time next to the bundle built from them — and the sourcemaps
  already embedded `sourcesContent`, so that copy was not even what a debugger reads.

  Maps are no longer emitted at all: 1.67 MB across the workspace, most of it the same
  source text a third time. `declarationMap` alone drove it — `sourceMap` never had any
  effect on this build, because it is `rolldown-plugin-dts` that turns on rolldown's shared
  `output.sourcemap` whenever `declarationMap` is set, and that is what overrode
  `sourcemap: false` in all seventeen `tsdown.config.ts` files. `declarationMap` is now off
  in `tsconfig.base.json` with a note naming `dts: { sourcemap }` as the direct lever, since
  setting it back silently restores every byte.

  With the sources gone there is no longer a reason to ship the bundle unminified, so
  `minify` is on: summed across the seventeen published packages, every `.mjs` under `dist/`
  goes from 916,821 to 279,839 bytes.

  Published output is now `dist/*.mjs` and `dist/*.d.mts`, plus `wasm/` for the language
  plugin. The trade is that a stack trace from an installed copy no longer resolves to
  original source; the sources remain a `git clone` away, and no API, behaviour or emitted
  IR changed anywhere.

## 0.2.0

### Minor Changes

- 5c36d16: Relicense from MIT to the Apache License 2.0.

  The terms are still permissive, and nothing about how you may use, modify, or
  redistribute Aburi narrows. Apache 2.0 adds two things MIT leaves unsaid: an
  express patent grant from every contributor, and a termination clause that
  withdraws it from anyone who brings a patent claim over the work. Redistributors
  now also carry two obligations MIT did not impose. State the changes you made to
  any file you modified, and pass along the `NOTICE` file.

  Each package now ships a copy of the licence in its own tarball, which Apache
  2.0 section 4(a) asks for and the SPDX field alone did not satisfy.

  Versions published before this change stay under MIT. A licence already granted
  cannot be withdrawn, so anyone depending on an earlier release keeps the terms
  they got.

## 0.1.0

### Minor Changes

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
