# @aburi/effects-trpc

## 0.2.1

### Patch Changes

- Updated dependencies [be8e2b9]
- Updated dependencies [3774de6]
- Updated dependencies [203ea78]
- Updated dependencies [ba9e505]
  - @aburi/types@0.4.0
  - @aburi/plugin-registry@0.3.1

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
  - @aburi/plugin-registry@0.3.0
  - @aburi/types@0.3.0

## 0.1.0

### Minor Changes

- 476e6bc: Add `@aburi/effects-trpc`, a new effect plugin that classifies tRPC client
  procedure calls into the core `network.rpc` effect vocabulary.

  ### Recognised shapes

  Two-signal join before returning an effect:

  1. The file's import list must contain `@trpc/client`, `@trpc/react-query`, or
     `@trpc/next` — exact match or any subpath (`@trpc/client/links/httpBatchLink`,
     `@trpc/next/app-dir/client`, ...). The gate is a **prefix match** rather than a
     closed allowlist because tRPC moves its deep entry points between minors; the
     `/` separator keeps lookalikes (`@trpc/client-mock`,
     `@trpc/react-query-devtools`) out. No import → `null` and control flows to the
     next effect plugin.
  2. `CallCandidate.target` must be at least three segments — tRPC's proxy is
     always addressed as `<client>.<procedure path…>.<terminal>`, so even a
     top-level procedure (`client.getUser.query()`) has three — and its terminal
     must be in the client vocabulary:
     - `query` / `useQuery` / `useInfiniteQuery` / `useSuspenseQuery` /
       `useSuspenseInfiniteQuery` / `usePrefetchQuery` / `usePrefetchInfiniteQuery`
     - `mutate` / `useMutation`
     - `subscribe` / `useSubscription`

  A leading `this` receiver is stripped before the segment count and the path are
  computed, so `this.trpc.user.byId.query()` inside a class method yields the same
  procedure path as the same call through a module-level binding.

  ### One effect id, three families

  Every recognised shape returns core `network.rpc`. Subscriptions included: tRPC
  v11 runs them over either `wsLink` (WebSocket) or `httpSubscriptionLink` (SSE),
  and the transport is not statically decidable from the call site, so committing
  to `network.ws` would be a guess. The distinction rides in `derivedBy` instead,
  together with the router-relative procedure path:
  `effects-plugin:trpc:query:user.byId` /
  `effects-plugin:trpc:mutation:user.create` /
  `effects-plugin:trpc:subscription:onAdd`. The path is information
  `Effect.target` does not carry on its own — `target` still holds the local client
  binding and the terminal.

  ### Server-side routers are not effects

  `t.router({...})` and `publicProcedure.input(...).query(resolver)` are never
  classified. A router definition is a Boundary, and per extension-vocab.md §6.1 a
  `type: "effects"` plugin may not declare the `framework:trpc:*` extKinds that
  Boundary classification would need — that is a companion framework plugin's job.

  The two sides collide concretely: the language plugin normalizes
  `publicProcedure.input(schema).query(resolver)` to `publicProcedure.input.query`,
  structurally identical to a client call. Since the import list is the only
  discriminator, **the `query` terminal is not classified in any file that imports
  `@trpc/server`**. The suppression is scoped to `query` alone — the server spells
  its other verbs `mutation` / `subscription`, absent from the client vocabulary —
  so `mutate` / `subscribe` / the hooks keep classifying in a file that colocates a
  router and a client.

  ### Deliberately unclassified
  - `useUtils()` / `useContext()` and the cache helpers reached through them
    (`invalidate` / `fetch` / `prefetch` / `ensureData`): the receiver is a local
    binding with nothing tying it back to tRPC, and `fetch` is far too generic to
    claim.
  - `queryOptions()` / `infiniteQueryOptions()` / `mutationOptions()` /
    `subscriptionOptions()` from `@trpc/tanstack-react-query`: they build an options
    object, and the request happens in the `useQuery` that consumes it.
  - `createCaller` invocations (`caller.user.byId()`): invoked by the procedure's
    own name, so there is no terminal to match.

  ### Known limitations
  - Components that import a local wrapper (`import { trpc } from "~/utils/trpc"`)
    instead of `@trpc/*` do not pass the import gate. Resolving that needs
    cross-file binding resolution — the LSP enrichment tier.
  - `subscribe` shares its name with RxJS and EventEmitter APIs. The three-segment
    minimum plus the client import gate filter almost all of it; a file colocating
    RxJS with a tRPC vanilla client is the residual risk.
  - Only the first segment is treated as the client binding, so a client behind a
    longer receiver chain (`api.trpc.user.byId.query()`, or a `this` aliased to
    `self`) records an over-qualified path — `trpc.user.byId` rather than
    `user.byId`. The effect id and `target` stay correct; nothing in the target
    string marks where the binding ends and the router path begins.

  ### Manifest

  `type: "effects"` with `xPrefix` deriving to `"trpc"` from the package name.
  `provides.effects` and `provides.effectPrefixes` are empty — every
  classification returns core-owned `network.rpc`, which extension-vocab.md §5.1
  forbids a plugin from declaring. `extKinds` / `extKindPrefixes` / `frameworks`
  are empty and must stay so for a `type: "effects"` manifest.
  `derivedByPrefixes: ["effects-plugin:trpc"]` owns the plugin-scoped rationale so
  consumers can trace every effect back here.

  ### Public API

  `trpcEffectsPlugin` (ready-to-register instance), `TrpcEffectsPlugin` (class),
  `classifyTrpcCall`, `hasTrpcClientImport`, `effectsTrpcManifest`, the
  terminal-vocabulary constants (`TRPC_QUERY_TERMINALS`,
  `TRPC_MUTATION_TERMINALS`, `TRPC_SUBSCRIPTION_TERMINALS`) with corresponding
  type guards, plus types `TrpcQueryTerminal`, `TrpcMutationTerminal`,
  `TrpcSubscriptionTerminal`.

  The server-import check that drives the `query` suppression is intentionally not
  exported — it is the classifier's internal discriminator, and a future
  `@aburi/framework-trpc` needs server-side detection scoped to what Boundary
  classification requires rather than to this suppression rule.

  ### Purity

  `classify()` is a pure lookup — no I/O, no state, no async — matching the
  per-call timeout budget the core enforces (effect-plugin.md §5.1.1). Repeated
  invocations against the same CallCandidate produce identical results, and the
  plugin holds no state across calls. It throws only on upstream contract
  violations: a malformed `CallCandidate.target` (empty string, adjacent dots) or a
  malformed `ImportEdge.source`, both with the offending file path in the message.

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
