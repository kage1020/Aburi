# @aburi/plugin-registry

## 0.3.1

### Patch Changes

- Updated dependencies [be8e2b9]
- Updated dependencies [3774de6]
- Updated dependencies [203ea78]
- Updated dependencies [ba9e505]
  - @aburi/types@0.4.0

## 0.3.0

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

- 4c16cad: Point every schema id at the documentation domain

  The four JSON Schemas identified themselves as `https://aburi.dev/schema/...`, a host this
  project does not own and never served them from. The docs site is `aburi.kage1020.com`, so
  that is the name the `$id`s, the `$schema` `const`s, the `$schema` an `aburi init` writes,
  and the plugin manifests now carry.

  The documentation site now serves the four schemas under `/schema/`, so each `$id` resolves
  to the document it names and an editor reading a `$schema` line gets completion and
  validation from it. A build-time check refuses to publish a schema whose `$id` disagrees with
  the URL it is served at.

  `$schema` is validated with a `const`, so an `aburi.json` or a plugin manifest still naming
  the old host is rejected until the string is updated — a find-and-replace of
  `aburi.dev/schema` with `aburi.kage1020.com/schema`, or a re-run of `aburi init --force`.

- 6d3d390: Match a decorator on the name it was imported under, and read where it came from

  `framework-nestjs` compared `Decorator.name` against four literal tables. The name a decorator
  is written with is not evidence on its own, and matching it alone got the answer wrong in both
  directions:

  ```ts
  import { Controller as Ctrl, Get as Fetch } from "@nestjs/common";
  @Ctrl("/b")
  export class BController {
    // was extKind: null — the boundary disappeared
    @Fetch("/list") list() {} // was extKind: null
  }
  ```

  ```ts
  import { Controller } from "routing-controllers";
  @Controller("/x")
  export class XController {} // was framework:nestjs:controller, confidence: "high"
  ```

  The first is the reported bug: a renamed import takes the boundary off the class _and_ off
  every route it owns, and nothing in the IR records that anything was missed. The second is the
  same missing evidence pointing the other way — a competing library's decorator claimed as
  NestJS, at full confidence.

  `ImportEdge` already carried what was needed. `symbols` records the recoverable form
  (`"Controller as Ctrl"`) and `source` records the module. The framework plugins could not see
  either: their context was `ExtractionContext`, which has no imports.

  ## Framework plugins now receive the file's import edges

  `FrameworkPlugin.classifySymbol` takes a `FrameworkClassifyContext` — `ExtractionContext` plus
  the file's `ImportEdge[]`, the same list `parseFile` produced. This mirrors what effect plugins
  already get through `ClassifyContext.file.imports`.

  A plugin that has no use for the edges needs no change: declaring the parameter as the supertype
  `ExtractionContext` still satisfies the interface. `framework-express`, `framework-next` and
  `framework-react` do no name matching against a package's vocabulary and are untouched.

  ## Three tiers of evidence

  | What the file's edges say about the written name | Matched against   | Confidence |
  | ------------------------------------------------ | ----------------- | ---------- |
  | imported from `@nestjs/*`                        | the imported name | `high`     |
  | imported from anything else                      | the imported name | `medium`   |
  | named on no edge                                 | the written name  | `high`     |

  The middle row downgrades rather than refuses, and that is the one judgement call here. A NestJS
  monorepo conventionally re-exports `@nestjs/common` through a tsconfig path alias (`@app/common`),
  which is indistinguishable from a foreign npm package without reading `tsconfig.json`. Refusing
  would take the boundary off every controller in such a project — the same loss this change exists
  to prevent, at a larger scale. `medium` is what `ir-schema.md` §5.4 calls an identifier match,
  which is exactly what is left when provenance is unknown.

  **So a `@Controller` from a competing library still classifies as NestJS**, now at `medium`
  rather than `high`. Closing that properly needs tsconfig path resolution, which is filed
  separately.

  The last row is the status quo, and is what a decorator reached through a namespace import
  (`import * as nest from "@nestjs/common"` → `@nest.Controller()`) falls into: the language plugin
  hands over the leaf identifier and `Decorator` carries no qualifier to tie it back to the
  namespace binding. That makes it the one row not ordered by how much the file disclosed — a
  namespace import from a _competing_ library also lands here, and is therefore trusted further
  than the named import of the same decorator would be.

  Two further shapes stay at `high` that the table above does not obviously cover, both because a
  re-export names a symbol without binding it in local scope:

  ```ts
  import { Controller } from "routing-controllers"; // the binding the file actually uses
  export { Controller } from "@nestjs/common"; // binds nothing; re-publishes the name
  @Controller()
  export class C {} // → nestjs:controller, high
  ```

  The duplicate rule prefers the NestJS edge, so a non-binding edge displaces a real one and skips
  the middle tier. And an aliased re-export (`export { X as Y } from './z'`) reaches the plugin as
  `"X"` alone — the language plugin composes `" as "` on imports but not on re-exports — so the name
  the file publishes is not the name that gets indexed. Both are pinned by tests rather than left to
  be rediscovered.

  Duplicate bindings resolve NestJS-over-foreign in either order; every other duplicate (two foreign
  edges, or two NestJS edges disagreeing on the exported name) is settled by write order, which is
  arbitrary rather than reasoned.

  Provenance is tested against the `@nestjs/` scope rather than a package list — `@nestjs/common`,
  `@nestjs/microservices` and `@nestjs/websockets` all supply vocabulary today and the set grows.

  ## What changes in the IR

  A file that renames a NestJS decorator on import gains an `extKind` on the class and on each of
  its routes, and `boundary: true` on the decorators, where it previously had none. A file that
  takes matching vocabulary from a module outside the scope keeps its `extKind` and drops to
  `Symbol.confidence: "medium"`.

  One direction **loses** a classification. Because the match moved to the imported name, a
  decorator whose local name only happens to spell vocabulary no longer counts as it:

  ```ts
  import { Thing as Controller } from "./thing";
  @Controller()
  export class C {} // was framework:nestjs:controller; now null
  ```

  That is the change working — the file states outright that `Controller` here is `Thing` — but it
  is the one case where a Symbol drops its `extKind` and its decorator boundary flags with no source
  change, so it lands as diff noise the same way the gains do.

  The downgrade is a record rather than a signal: nothing downstream reads a Symbol's `confidence`
  today. The diff compares it only on effects, and the Markdown projection's badge renders only on
  effect rows, so a `medium` Symbol is visible in the IR document and nowhere else. That is why the
  tier costs no diff churn, and equally why it cannot yet be acted on. The projection side is a
  pre-existing gap against `ir-schema.md` §5.4 and is tracked separately.

  `derivedBy` now carries the imported name (`framework:nestjs:route:Get` for a `@Fetch()` that was
  `import { Get as Fetch }`), because it is a closed vocabulary that filters and diffs read and a
  rename changes nothing about the route. `Decorator.name` and `.raw` keep the spelling the source
  used, and `decoratorBoundaries` stays keyed on it — that is what the core matches against when it
  folds the classification back onto the Symbol.

  ## Supporting moves

  `splitAliasedImportName` is exported from `@aburi/core`. It parses the `ImportEdge.symbols` wire
  format, which now has two readers — the call-graph resolver and the framework plugins — so it is
  no longer private to the resolver.

  Its unaliased branch now trims, which it did not while it was private to the resolver, so
  `"  Controller  "` resolves where it previously matched nothing.

  `assertImportEdgeSource` is exported from `@aburi/plugin-registry/plugin-input`, factored out of
  `hasMatchingImport` so a plugin that walks the edge list itself rejects an empty module specifier
  the same way and with the same message. `assertImportBinding` joins it for the other field of the
  same edge: a `symbols` entry with an empty half (`" as Y"`, `"X as "`) names nothing, and a
  consumer that looked it up in a vocabulary table would miss every entry and drop the
  classification silently — with a decorator, taking the owning class's `extKind` with it.

  `Decorator.name` is now NFC-normalized alongside the other strings this boundary collapses
  (`scan/pipeline.ts`). `ImportEdge.symbols` was already normalized, so leaving the decorator alone
  left the two halves of the new comparison in different spellings, and an alias silently failed to
  resolve on a file that spells its identifiers decomposed. `Decorator.raw` is untouched — it is a
  quotation of source.

  `FrameworkClassifyContext.imports` is `readonly`. The pipeline hands over the live array, not a
  copy: it is the same instance reported as the file's imports and read by call resolution, so a
  plugin that sorted or spliced it would rewrite the IR from inside a classifier. `framework-nestjs`
  memoizes its name index on that array's identity, which makes the index per file rather than per
  decorated Symbol — the difference between linear and (declarations × import entries) on a large
  controller.

### Patch Changes

- Updated dependencies [5c36d16]
- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [8ce6ed4]
- Updated dependencies [4c16cad]
- Updated dependencies [6d3d390]
- Updated dependencies [cafd4b8]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [14bdb6b]
  - @aburi/types@0.3.0

## 0.2.0

### Minor Changes

- be40074: Hoist the language-plugin input guards into a shared
  `@aburi/plugin-registry/plugin-input` surface and migrate every effect plugin onto
  it.

  ### What moved

  Two fail-fasts had been copied into all four effect plugins, and the copies had
  drifted:

  - `assertNonEmptySegments` — rejects a `CallCandidate.target` that is empty or has
    an empty `.`-separated segment. `effects-drizzle` / `effects-trpc` threaded the
    file path into the message; `effects-prisma` / `effects-nest` did not, and both
    returned their tuple through an `as unknown as` double cast.
  - The `ImportEdge.source` check inside each `has*Import` — same split, with
    `effects-prisma` / `effects-nest` again omitting the file path and line.

  Both now live in one implementation, parameterized by a `{ plugin, filePath }`
  record so the message names the plugin that rejected the value and the file that
  produced it.

  ### New public surface

  `@aburi/plugin-registry/plugin-input` exports:

  - `assertNonEmptySegments(target, origin)` → `{ segments, last }`. `segments` is a
    `readonly [string, ...string[]]` tuple built without a cast, and `last` hands
    classifiers the terminal segment so `parts.at(-1) as string` disappears from
    every call site.
  - `hasMatchingImport(imports, origin, matches)` — validates every `ImportEdge`
    before matching, so throw behaviour never depends on import order. Folding the
    validation and the match into one function is what makes that ordering
    unforgeable: there is no way to ask "does this file import X?" while skipping
    the check. The predicate receives the module specifier alone — the smallest
    argument every caller needs, and one that can be widened compatibly later.
  - Types `NonEmptySegments`, `PluginInputOrigin`, `CallTargetSegments`.

  It is a dedicated subpath rather than a barrel export because
  `@aburi/plugin-registry`'s root compiles the plugin JSON Schema with ajv at module
  scope — importing it from a classifier would put a full schema compilation on the
  startup path of every effect plugin. The subpath's only import is a type, so
  evaluating it runs none of that. It bounds evaluation, not installation: taking
  this dependency still puts `ajv` and `jsonc-parser` in an effect plugin's
  dependency tree, which was the accepted trade for not publishing a separate
  package for two functions.

  ### Behaviour changes
  - **`@aburi/effects-prisma` / `@aburi/effects-nest`**: throw messages now carry the
    source file (and, for import-edge violations, the line):
    `effects-prisma: CallCandidate.target is empty — …` becomes
    `effects-prisma (src/services/x.ts): CallCandidate.target is empty — …`.
    A contract violation propagates rather than degrading to an unclassified call
    (effect-plugin.md §10, EP3a), so these reach the user; anything matching on the
    exact string needs updating.
  - **`hasPrismaImport` / `hasNestEmitterImport` now require a second `filePath`
    argument**, matching `hasDrizzleImport` / `hasTrpcClientImport`. The path is
    what makes the thrown message actionable, so it is required rather than
    optional.
  - **`@aburi/effects-drizzle` / `@aburi/effects-trpc`**: no behaviour change —
    every thrown message and existing signature is byte-identical to before. They
    are minor rather than patch only because of the added `EFFECTS_*_PLUGIN_NAME`
    export below.

  Each plugin also gained a leaf `constants.ts` holding its name and `derivedBy`
  prefix, which removes the `manifest.ts → classify.ts` import edge and keeps the
  name the manifest declares identical to the one the guards print. The plugin-name
  constants (`EFFECTS_PRISMA_PLUGIN_NAME` and siblings) are exported alongside the
  existing `EFFECTS_*_DERIVED_BY_PREFIX` values.

  The normalized-callee contract these guards enforce — non-empty `target`, no empty
  segments, non-empty `ImportEdge.source` — is now written down in
  `docs/design/lang-plugin.md` §4.4 instead of living only in four copies of a
  comment.

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

- a8882f0: Introduce the `@aburi/plugin-registry` package. Validates plugin manifests via ajv against `aburi.plugin.v1.json`, then registers their owned extKind / effect id / framework / derivedBy namespaces while enforcing reserved-namespace exclusivity (`core` / `aburi` / `_` / `framework:hint`), xPrefix derivation and consistency, type-namespace ownership, prefix-id shadowing, and prefix-prefix overlap in both directions. Surfaces `VocabRegistry`, `RegistryError`, `loadPluginManifest`, `parsePluginManifest`, and the `RESERVED_NAMESPACES` / `TYPE_NAMESPACE_RULES` constants.

  `@aburi/types` patch: `EffectVocab.description` and `ExtKindVocab.{baseKind, description}` are now nullable to model registry resolution through prefix ownership (`findEffect` / `findExtKind` return non-null for prefix-owned ids that the plugin did not enumerate individually).

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

- 0445f93: Introduce the `@aburi/config` package. Parses `aburi.json` / `aburi.jsonc` (JSONC with comments and trailing commas) through `jsonc-parser`, validates against `aburi.config.v1.json` via ajv strict mode, and surfaces typed errors with parse offsets / filesystem errno embedded in the message. Normalizes `frameworkHints[]` into synthesized framework-type `PluginManifest` entries by auto-inserting `hint:` as the second segment of each `extKind` value, deriving `extKindPrefixes` / `derivedByPrefixes` ownership from the resulting values, and rejecting user-written `framework:hint:*` extKinds. Adds workspace-walking config discovery (`aburi.jsonc` preferred over `aburi.json`, returns `null` when no ancestor has a config so the consumer can fall back to autodetect). Public API: `loadConfig`, `parseConfig`, `readConfigFile`, `findConfig`, `normalizeFrameworkHints`, `ConfigError`, plus `LoadedConfig` / `FindConfigOptions` / `ConfigErrorCode` types.

  `@aburi/plugin-registry` patch: `loadPluginManifest` now extracts the filesystem errno from Node `SystemError` instances (which inherit from `Error` and were previously rejected by the plain-object guard), so failure messages include `ENOENT` / `EACCES` / `EISDIR` instead of falling back to `unknown`.

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
