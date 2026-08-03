# @aburi/effects-drizzle

## 0.1.0

### Minor Changes

- e4a5dac: Add `@aburi/effects-drizzle`, a new effect plugin that classifies Drizzle ORM
  call expressions into the core `db.read` / `db.write` / `db.transaction`
  effect vocabulary.

  ### Recognised shapes

  Two-signal join before returning an effect:

  1. The file's import list must contain `drizzle-orm` or any driver subpath
     (`drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`,
     `drizzle-orm/mysql2`, `drizzle-orm/better-sqlite3`,
     `drizzle-orm/bun-sqlite`, `drizzle-orm/neon-http`,
     `drizzle-orm/neon-serverless`, `drizzle-orm/d1`,
     `drizzle-orm/planetscale-serverless`, `drizzle-orm/libsql`,
     `drizzle-orm/vercel-postgres`, `drizzle-orm/xata-http`,
     `drizzle-orm/expo-sqlite`, ...). The gate is a **prefix match** rather than
     a closed allowlist because Drizzle ships new driver entry points per
     release. No import → `null` and control flows to the next effect plugin.
  2. The trailing segments of `CallCandidate.target` must match Drizzle's public
     surface:
     - `<client>.select()` / `<client>.selectDistinct()` /
       `<client>.selectDistinctOn()` — root of a fluent query chain → `db.read`
     - `<client>.query.<table>.findMany` / `findFirst` — relational query API
       (4+ segments with `query` at index -3) → `db.read`
     - `<client>.insert(...)` / `<client>.update(...)` / `<client>.delete(...)` —
       root of a fluent write chain → `db.write`
     - `<client>.transaction(...)` / `<client>.batch(...)` (argCount ≥ 1) →
       `db.transaction` (`batch` covers the Neon / Cloudflare D1 multi-statement
       API which is semantically a transaction)

  ### Fluent-chain one-classification invariant

  Drizzle is a fluent builder — `db.select().from(u).where(w).orderBy(o)` — where
  the language plugin emits one CallCandidate per link (`db.select`,
  `db.select.from`, `db.select.from.where`, ...). The classifier keeps
  **one classification per chain** by rejecting any target whose internal
  segments contain a fluent-root verb (`select` / `selectDistinct` /
  `selectDistinctOn` / `insert` / `update` / `delete`). Only the 2-segment root
  survives and is anchored to the query origin line, so a single SQL statement
  produces exactly one effect record no matter how long its chain.

  ### Raw SQL

  `.execute()` is deliberately **not** classified — a raw SQL call can be a
  read or a write and static disambiguation would require SQL parsing (out of
  scope). This mirrors how `@aburi/effects-prisma` treats `$queryRaw` /
  `$executeRaw`.

  ### Manifest

  `type: "effects"` with `xPrefix` deriving to `"drizzle"` from the package
  name. `provides.effects` and `provides.effectPrefixes` are empty for v0.1 —
  every classification returns core-owned `db.*` vocabulary, which
  extension-vocab.md §5.1 forbids a plugin from declaring.
  `derivedByPrefixes: ["effects-plugin:drizzle"]` owns the plugin-scoped
  rationale so consumers can trace every effect back here.

  ### Public API

  `drizzleEffectsPlugin` (ready-to-register instance), `DrizzleEffectsPlugin`
  (class), `classifyDrizzleCall`, `hasDrizzleImport`, `effectsDrizzleManifest`,
  the method-vocabulary constants (`DRIZZLE_READ_METHODS`,
  `DRIZZLE_WRITE_METHODS`, `DRIZZLE_TRANSACTION_METHODS`,
  `DRIZZLE_QUERY_METHODS`, `DRIZZLE_FLUENT_ROOT_METHODS`) with corresponding
  type guards, plus types `DrizzleReadMethod`, `DrizzleWriteMethod`,
  `DrizzleTransactionMethod`, `DrizzleQueryMethod`.

  ### Purity

  `classify()` is a pure lookup — no I/O, no state, no async — matching the
  per-call timeout budget the core enforces (effect-plugin.md §5.1.1).
  Repeated invocations against the same CallCandidate produce identical
  results, and the plugin holds no state across calls.

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
- Updated dependencies [be40074]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/types@0.2.0
  - @aburi/plugin-registry@0.2.0
