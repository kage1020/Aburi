# @aburi/framework-next

## 0.1.0

### Minor Changes

- 7581f2a: Introduce `@aburi/framework-next`, the Next.js framework plugin. Recognizes the App Router special files (page / layout / template / loading / error / not-found / route) and the top-of-module `"use client"` / `"use server"` directives.

  ### File-based classification

  The plugin joins two signals from the extraction pipeline:
  - `Symbol.source.file` → resolved against the App Router path convention. A file only counts as an App Router special file when the path includes an `app/` segment and the base filename is one of the seven reserved names with a `.ts` / `.tsx` / `.js` / `.jsx` extension.
  - `ctx.file.content` → scanned for a top-of-module `"use client"` / `"use server"` directive.

  ### Component roles
  - `app/**/page.{ts,tsx}` default export function → `framework:next:page`
  - `app/**/layout.{ts,tsx}` default export function → `framework:next:layout`
  - `app/**/template.{ts,tsx}` → `framework:next:template`
  - `app/**/loading.{ts,tsx}` → `framework:next:loading`
  - `app/**/error.{ts,tsx}` → `framework:next:error`
  - `app/**/not-found.{ts,tsx}` → `framework:next:not-found`

  Named-but-default exports (`export default function Page() {}`) are recognized via the language plugin's `export-default` derivedBy marker rather than via the qname, so the plugin catches both the anonymous and named forms.

  ### Route handlers

  `app/**/route.{ts,js}` named HTTP verb exports (GET / POST / PUT / DELETE / PATCH / OPTIONS / HEAD) → `framework:next:route`. Non-verb helper exports in the same file are ignored.

  ### Client / server distinction

  When the file starts with `"use client"` or `"use server"`, the classifier appends `framework:next:client-component` / `framework:next:server-action` to the `derivedBy` string after a `;` delimiter. Consumers that split on `;` recover both signals; the framework role stays in the leading segment for consumers that only need it.

  ### Manifest

  `extKindPrefixes: ["framework:next"]` for future App Router additions plus individual `extKinds` enumeration (7 ids, all `baseKind: function`) so `VocabRegistry.findExtKind()` returns proper baseKind fallback. `frameworks: ["nextjs"]` matches the identifier `@aburi/core`'s Component autodetect emits for the `next` dependency.

  ### Public API

  `nextFrameworkPlugin` (ready-to-register instance), `NextFrameworkPlugin` (class), `frameworkNextManifest`, `classifyNextSymbol`, `recognizeAppRouterFile`, `detectModuleDirective`, `NEXT_APP_ROUTER_ROLES`, `NEXT_ROUTE_HTTP_VERBS`, plus types `AppRouterFile`, `AppRouterRole`, `ModuleDirective`.

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
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/core@0.1.0
