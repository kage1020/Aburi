# @aburi/config

## 0.2.0

### Minor Changes

- cafd4b8: Stop reporting success for a scan that read almost none of the workspace

  `runScan`'s exit code was `extractionFailures.length > 0 ? GATE : SUCCESS` and nothing about
  coverage reached it. A run that discovered 1200 files and withdrew every one of them wrote
  `out/aburi.ir.json`, exited `0`, and diffed against the next one as `+0 -0 ~0` — passing every
  `--fail-on` gate. The one guard that existed, `requireLanguagePlugin`, closes a single route to
  that shape and says in its own docblock why the shape is dangerous: it is a **success**, so the
  run that lost the workspace is the one that looks healthiest.

  **`parsedFiles === 0` now exits `3`**, with the line that accounts for the code printed above
  the census that is its evidence:

  ```
  ⚠ 1200 file(s) discovered, 0 parsed — 1200 as parse-failed. The IR is empty and will diff clean against any other empty IR.
  ⚠ 1200 file(s) contributed no Symbols: parse-failed=1200
  ⚠ parse-failed (1200) — the language plugin refused the source. Deterministic: fix the file, or the plugin.
      src/a.ts: parse reported a non-recoverable error at 1:1 — unexpected token
      …
  ```

  Two wordings from one condition, because the first move differs. Discovering nothing is a
  question about the config — `ignore`, `.gitignore`, `components[].roots`, whether a loaded plugin
  claims any extension here — so that line names those. Discovering files and parsing none is a
  question about whatever withdrew them, so that line names the reason that took the most, ties
  broken by the reason enum's order so the sentence does not depend on the order of the walk.

  **A workspace can set a floor above zero: `minParsedFileRatio` in `aburi.json`.** Absent by
  default. Where the line sits between "lost some files" and "lost the workspace" depends on the
  repository, and a default would red a build for a judgement nobody made. Set it and the scan
  gates when `parsedFiles / totalFiles` falls below it — `<`, not `<=`, the reading `--fail-on`'s
  thresholds already use. A floor of `0` is refused by the schema: nothing can fall below it, so
  the key would be a policy that does nothing.

  `@aburi/config` is released alongside the CLI because the key lives in `aburi.config.v1.json`,
  which that package inlines at build time and validates with `additionalProperties: false` at the
  root. The CLI bundles `@aburi/config` as an external, so a CLI published against the previously
  released config would reject a correct `minParsedFileRatio` with exit 2 — while the monorepo
  suite, which reads the workspace schema, saw nothing wrong.

  **The floor counts every skip reason.** `parse-timeout` is the one whose loss varies by machine,
  and so the one a floor is usually reached for, but it is not the only one that hides a blind
  spot: which reason produced the loss decides the fix, not whether coverage collapsed. Every
  reason is named per file directly below either way.

  **`keptSymbols` plays no part.** A file that parses cleanly and declares nothing is counted as
  parsed, which is correct — a repository of configuration and tests is not a failed scan — so a
  Symbol count says something about the code where `parsedFiles` says what this policy is about.

  **One construction.** `ScanReport` gains `parsedFiles` and `coverageFault`, computed once. The
  exit code derives from it, the incident report renders it, and `aburi diff` names it as the cause
  of its own exit, so the three cannot disagree about whether the run was green.

  **`aburi diff` names it.** `warnOnScanFault` said its wording comes from what the scan reported
  rather than from the gate condition "so a second reason arrives with the code right and the
  message still true", and fell back to `The base scan did not exit clean`. This is that second
  reason, and it now reads `The base scan parsed none of the 1200 file(s) it found`. A plugin
  exception is named first when both apply: a scan that threw on every file has the coverage fault
  as a consequence of it rather than as a second finding.

  The IR is written under both gates, as it already was for a plugin exception — a reviewer gets
  the partial artifact and a non-zero code rather than neither.

### Patch Changes

- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [8ce6ed4]
- Updated dependencies [6d3d390]
- Updated dependencies [cafd4b8]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [14bdb6b]
  - @aburi/types@0.3.0

## 0.1.1

### Patch Changes

- b2f4382: Give `SymbolId`, `ComponentId`, and `SliceId` separate identities instead of three names for `string`.

  Aburi mints three kinds of identifier and each owns a namespace, but all three were the
  same type. `SymbolId` and `ComponentId` were bare aliases of `string`
  (`aburi.ir.v1.json#/$defs/*` are `{"type": "string"}`, and json-schema-to-typescript
  faithfully generates what the schema says); `SliceId` did not exist at all, so
  `SliceRecord.id` was `string` and `SliceRecord.members` was `string[]`. Nothing stopped a
  Component id being passed where a Symbol id was wanted, and `"slice:" + members[0]` — the
  Slice-id derivation — was an expression any file could open-code, because its result was
  assignable to the field it fed.

  `SymbolId` and `ComponentId` are now nominal types, `SliceId` exists and is nominal too,
  and `dependencies[].from` / `.to` are `SymbolId | ComponentId` rather than `string` — the
  union is honest about the one array that holds both kinds, while still refusing an
  arbitrary string. Every brand comes from a constructor: `makeSymbolId` / `trySymbolId` /
  `makeComponentId` in `@aburi/core` and `sliceIdFor` in `@aburi/diff`. Assertions
  (`x as SymbolId`) survive in four documented places and nowhere else — `packages/core/src/id.ts`,
  `sliceIdFor` plus the untyped-input predicate in `packages/diff/src/slice.ts`, the single
  `parsed as unknown as IR` in `readIR`, and per-package test fixtures, which need to be able
  to write a malformed id for the cases that exist to reject one.

  Two call sites were building Symbol ids by concatenation behind a type annotation and now
  go through the constructor: the call-graph resolver and the LSP enrichment pass, which
  assemble _speculative_ callee ids and test them for existence. Those use `trySymbolId`, the
  non-throwing variant — an id that cannot be built is a callee that cannot exist, which is
  the same answer as a well-formed id absent from the Symbol table, so resolution behaviour is
  unchanged. `@aburi/diff`'s git-rename stage, which rebuilds an id around a moved file path,
  goes through the same constructor for the same reason.

  The brands are TypeScript-only and erased at runtime. Scanning and diffing the
  `nestjs-billing` fixture produces byte-identical `ir.json`, `diff.json`, `workspace.md`, and
  `diff.md` before and after.

  ### Schema

  `aburi.ir.v1.json` and `aburi.diff.v1.json` gain three `$defs` — `DependencyEndpoint`,
  `SliceId`, and a loose `SymbolId` on the diff side — extracted verbatim from the inline
  subschemas they replace. The validation semantics are identical; the change exists so the
  generator has a named alias to attach a brand to. The brand itself is applied by a
  post-processing pass in `packages/types/scripts/codegen-lib.ts`, not by a `tsType`-style
  keyword in the schema: these are frozen v1 documents published for validators outside this
  repository, and a non-standard keyword would make every strict-mode validator reject the
  schema itself. That is the same reasoning that kept the Slice anchor keyword out of the file.

  ### Two new integrity invariants
  - **#16 — no reserved namespace.** Slice ids are `"slice:" + <anchor Symbol id>`, so a
    language plugin claiming the token `slice` would mint Symbol ids indistinguishable from
    Slice ids and make the derivation produce `slice:slice:…`. Branding cannot fix this — the
    strings are genuinely the same shape — so `makeSymbolId` rejects the token, and
    `checkIRIntegrity` rejects it in a Symbol id or a Dependency endpoint from a document it did
    not build. Only the whole token is reserved; `slicer` is still legal. `@aburi/diff` reports
    it as its own `SliceRecord` violation kind too, because `buildDiff` is public API and runs
    no integrity check. No plugin uses `slice` today.
  - **#17 — ids satisfy their own grammars.** `readIR` brands a whole parsed document with one
    `as unknown as IR`, which is the only way to type a JSON parse — so ids read from disk used
    to acquire their brand without anything looking at them, while every other route ran a
    constructor. #17 closes that: `symbols[].id` must satisfy `isSymbolId` and `components[].id`
    must satisfy `isComponentId`. It is also what catches a language plugin that asserts the
    brand instead of calling the constructor.

  ### Behaviour changes
  - **`ComponentId` accepts a digit-leading segment.** The pattern was
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and is now `^[a-z0-9]+(-[a-z0-9]+)*$`, in both
    `aburi.ir.v1.json` and `aburi.config.v1.json`. Component ids are derived by kebab-casing a
    package or directory name, and `3d-force-graph` / `7zip-bin` are ordinary npm names — the
    letter-first rule made the documented derivation partial for no benefit. Loosening a pattern
    is additive: every document that validated before still does.
  - **Component detection fails loudly on a name that yields no id at all.** After the pattern
    change only one case remains — a name that kebab-cases to the empty string. It now raises
    `invalid-component-id` naming the package or directory it came from, instead of putting `""`
    in `components[].id` and producing an IR that fails its own schema somewhere else entirely.
    The CLI wraps it as a `config-error`, so it exits 2 (input) rather than 1 (runtime).
  - **A Symbol id file path may not contain `:` or `#`.** They are the id's own separators, so a
    path holding either assembles into a string that still matches the schema pattern but splits
    back into parts the producer never wrote. `makeSymbolId` now refuses them, which is what lets
    `isSymbolId` recover the parts and re-run the constructor's own check.

  ### Packages with no source change

  `@aburi/config` and `@aburi/plugin-registry` are bumped for the `ComponentId` pattern change
  in `aburi.config.v1.json` and for the `@aburi/types` dependency, respectively; neither has a
  source diff.

  ### For plugin authors

  `SymbolCandidate.id` and `OwnerSummary.id` are `SymbolId` rather than `string`. A language
  plugin that already builds ids with `makeSymbolId` — as `@aburi/lang-typescript` does —
  needs no change. One that concatenates the parts itself will stop type-checking and should
  switch to the constructor, which enforces the `ir-schema.md` §3.1 grammar it was assuming.

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/types@0.2.0

## 0.1.0

### Minor Changes

- 0445f93: Introduce the `@aburi/config` package. Parses `aburi.json` / `aburi.jsonc` (JSONC with comments and trailing commas) through `jsonc-parser`, validates against `aburi.config.v1.json` via ajv strict mode, and surfaces typed errors with parse offsets / filesystem errno embedded in the message. Normalizes `frameworkHints[]` into synthesized framework-type `PluginManifest` entries by auto-inserting `hint:` as the second segment of each `extKind` value, deriving `extKindPrefixes` / `derivedByPrefixes` ownership from the resulting values, and rejecting user-written `framework:hint:*` extKinds. Adds workspace-walking config discovery (`aburi.jsonc` preferred over `aburi.json`, returns `null` when no ancestor has a config so the consumer can fall back to autodetect). Public API: `loadConfig`, `parseConfig`, `readConfigFile`, `findConfig`, `normalizeFrameworkHints`, `ConfigError`, plus `LoadedConfig` / `FindConfigOptions` / `ConfigErrorCode` types.

  `@aburi/plugin-registry` patch: `loadPluginManifest` now extracts the filesystem errno from Node `SystemError` instances (which inherit from `Error` and were previously rejected by the plain-object guard), so failure messages include `ENOENT` / `EACCES` / `EISDIR` instead of falling back to `unknown`.

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
