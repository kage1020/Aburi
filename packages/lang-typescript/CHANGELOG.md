# @aburi/lang-typescript

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

- e760103: Read a decorator wherever the grammar parents it, order them by source position, and let a JSDoc block reach past one

  **This changes what a Symbol carries, and the first scan after upgrading will report
  `modified` Symbols that no source change explains.** Decorators feed
  `mergeFrameworkClassification`, so a class that had no `extKind` can now have one; `signature`
  moves with the JSDoc change; and both feed the api and logic fingerprint axes. The drift is the
  point of the fix rather than a side effect — the Symbols were wrong before — but it lands as
  diff noise exactly once.

  ## Where the decorator is written no longer changes whether it is read

  A decorator always belongs to the declaration it precedes. Tree-sitter parents it beside that
  declaration when nothing separates the two, and inside it when the `export_statement` rule
  (`decorator* 'export' ['default'] declaration`) has nowhere to put it — so it is the position
  relative to the keyword that decides, not whether a wrapper exists. Only the first was read:

  | source                           | where the decorator sits                    | read before |
  | -------------------------------- | ------------------------------------------- | ----------- |
  | `class C { @A() m() {} }`        | preceding sibling in the class body         | yes         |
  | `@A() export class C {}`         | preceding sibling in the `export_statement` | yes         |
  | `@A() class C {}`                | child of `class_declaration`                | no          |
  | `export @A() class C {}`         | child of `class_declaration`                | no          |
  | `export default @A() class C {}` | child of `class_declaration`                | no          |
  | `@A() abstract class C {}`       | child of `abstract_class_declaration`       | no          |
  | `@A() export @B() class C {}`    | one of each                                 | only `A`    |

  The symptom was an IR that contradicted itself: `export @Controller("x") class A {}` produced a
  class with no boundary owning routes that had one.

  Every row is legal TypeScript except the last, which `tsc` rejects as TS8038 — decorators may
  not appear on both sides of `export`. The grammar accepts it, so it still reaches the extractor
  from a half-edited file, and reading the union rather than one side means such a file loses no
  decorator on the way to being reported.

  `readDecorators` now returns the union of the preceding-sibling run and the declaration's own
  `decorator:` field children. The two cannot overlap — a node has one parent, so a preceding
  sibling of the declaration is never also its child — which is why the union needs no
  deduplication. A **parameter** decorator (`m(@P() x)`) stays out of both: it is a child of the
  parameter, and the method does not field-tag it.

  ## Decorators are ordered by source position

  `framework-nestjs` resolves a class carrying several recognised decorators by taking the first
  in source order, so the order is a contract. It was a line sort with an alphabetical tiebreak,
  and `Decorator` has no column — so two decorators on one line came out in name order:

  ```ts
  @Injectable()
  @Catch(HttpException)
  class F {} // was framework:nestjs:filter
  @Injectable()
  @Catch(HttpException)
  class F {} // was framework:nestjs:provider
  ```

  A newline decided the classification, and `mergeFrameworkClassification` stamped the result
  `confidence: "high"` either way. Ordering on the node's byte offset settles it: total, agrees
  with the line ordering integrity invariant #11 checks, and needs no tiebreak.

  ## A JSDoc block reaches past a decorator, and only JSDoc counts

  `readLeadingJsDoc` stopped at a decorator, so `/** @throws E */ @Get() handler() {}` discarded
  the block and every `@throws` tag in it. A decorator is now stepped over — it belongs to the
  member rather than separating anything from it.

  That opens the space _between_ decorators, which is where `// biome-ignore`, ticket references
  and commented-out decorators are written. So the run now collects only `/**` blocks, which is
  what the function always claimed to read: an ordinary `/* … */` and a `//` line are prose, and
  the one consumer (`readThrows`, scanning the joined text for `@throws`) cannot tell prose from
  a declaration once both are in it. **A `@throws` written in a `//` or `/* */` comment therefore
  stops counting**, which it should never have done.

  An anonymous token still ends the run, which is what keeps a stray `;` from handing a member
  someone else's documentation.

  ## Also

  `@/* why */ Foo()` parses, and the decorator was being named after the comment rather than
  after `Foo`.

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

- ed1c3a0: Refuse an empty module specifier instead of emitting an edge that names no module

  `import x from ""` used to end the run. `readStringLiteral` returned `""` for an empty literal
  and all three call sites guarded only on `null`, so every form the reader produces an edge for
  produced one whose `source` names nothing, with no diagnostic:

  ```ts
  import a from ""; // { source: "", symbols: ["a"] }
  import ""; // { source: "", symbols: "*" }
  export * from ""; // { source: "", symbols: "*" }
  export { X } from ""; // { source: "", symbols: ["X"] }
  import type { B } from ""; // { source: "", symbols: ["B"] }
  const p = import(""); // { source: "", symbols: "*", dynamic: true }
  ```

  `ImportEdge.source` is contractually a non-empty specifier (`lang-plugin.md` §4.4), and the
  shared guards in `@aburi/plugin-registry/plugin-input` throw when it is not. So the guard fired
  on syntax a user can legally write — and because it fires inside a plugin, it took the whole
  scan with it:

  ```
  src/a.controller.ts   @Controller class, plus one `import x from ""`
  src/b.service.ts      @Injectable class, nothing wrong with it

  scan() → throws. No IR at all; `BService` is discarded along with the offending file.
  ```

  The reach is wide: a decorator-driven framework plugin walks the edge list for every file
  holding a decorated class or method, so any controller with a half-typed import ends the scan.
  Before framework plugins read import edges, the throw needed an effect plugin _and_ a call
  candidate in the same file.

  ## What the plugin does instead

  An empty specifier produces no edge and one **recoverable** `ParseError` at the literal's own
  line and column, naming which construct it belongs to — `export * from ""` is not an import, and
  being told that it is sends the author to the wrong line. The file keeps its Symbols: what
  withdraws one is a parse that returned no tree at all, which this is not.

  The diagnostic travels the channel a syntax error already uses, and reaches as far as that
  channel goes — `ScanResult.parseErrors`, carrying the file, line, column and message. The CLI
  renders parse errors as a count alone, so someone running `aburi scan` sees `1 file(s) had
recoverable parse errors` and has to read the programmatic result for the rest. That is an
  existing gap in the reporting layer rather than something this change introduces.

  Empty and absent stay apart. `readStringLiteral` returning `null` means the node was not a string
  literal — a computed specifier (`import(p)`, `import("" + x)`) the reader does not follow, which
  is not a fault in the source and gets no diagnostic. A literal that is present and empty is
  something someone typed. Collapsing the two into one silent `null` is the drop this change exists
  to stop, and it would also report a fault against perfectly good code.

  The test is emptiness, not blankness: `import a from " "` still produces an edge, because `" "`
  is a module name that will not resolve, which is the type checker's business. `tsc 6.0.3` reports
  TS2307 for the value forms above and TS2882 for the bare side-effect import — all of them parse,
  which is why they reach the extractor at all.

  The guard in `plugin-input` is unchanged. A third defensive layer would hide the next producer
  bug, which is the guard's whole job.

  ## What changes in the IR

  Nothing disappears from `dependencies`: `ImportEdge`s are not serialized — they reach
  `resolveCallGraph` and stop there, and an empty specifier was never relative, so no resolution
  tier ever consulted it.

  One second-order effect is visible. `bindsToExternalImport` buckets an unresolved call as
  `external` when its head is bound by a non-relative import, and `""` counted as non-relative.
  A call bound by the withdrawn edge now buckets as `no-match`, shifting `stats.callResolution` by
  one. Neither bucket describes a broken specifier — `external` means "a bare package, out of reach
  by construction" — and the parse error is the channel that does.

  ## Contract

  `extractImports` now returns `{ edges, errors }` rather than `ImportEdge[]`. It is part of the
  package's public surface, which is why this is a minor rather than a patch; `parseTypescriptFile`
  is unaffected and merges the import errors into `ParseResult.errors` alongside the syntax ones.

- 14bdb6b: Separate the `LanguageId` and `PluginRef` vocabularies

  `aburi.json` uses the key `languages` at two nesting levels with two different
  vocabularies: the top-level array holds plugin refs the loader resolves as module
  specifiers, while `components[].languages` holds `LanguageId`s constrained to
  `^[a-z][a-z0-9]*$`. Both writers conflated them.

  - `LanguagePlugin` gains a required `languageId` field. `@aburi/core` projects it into
    `IR.workspace.languages`, which previously received `manifest.name` and therefore
    emitted `"lang-typescript"` — a value that fails the frozen `aburi.ir.v1` schema for
    every first-party plugin. Third-party language plugins must add the field.
  - `LanguageId` is now a branded type constructed through `makeLanguageId` (exported from
    `@aburi/core`), so a manifest name can no longer be assigned where a language id belongs.
  - `aburi init` writes plugin manifest names (`lang-typescript`, `framework-nestjs`) in the
    top-level arrays and keeps `LanguageId`s inside `components[]`. It previously wrote
    detector ids, so the loader looked for the non-existent `@aburi/ts` package and the
    documented `init` then `scan` quick start failed on every project.
  - `InitReport` gains `unmappedLanguages` / `unmappedFrameworks`, and the CLI warns about
    them. A detected language with no first-party plugin leaves `languages` empty, which is
    otherwise invisible until the next command stops.
  - `--with-suggestions` names the language plugin first, per `cli-spec.md` §4.6: it is a
    hard requirement for the next `aburi scan`, where a framework plugin only widens
    classification.
  - `aburi scan` refuses to run when no language plugin resolves, instead of writing an IR
    with zero Symbols and an empty `workspace.languages` at exit 0. That document fails the
    schema's `minItems: 1`, and two of them diff to `+0 -0 ~0` — so every `--fail-on` gate
    downstream passed regardless of what changed.
  - New integrity invariant #18: `workspace.languages` is non-empty, every entry satisfies
    the `LanguageId` grammar, and every `Symbol.language` appears in it. It also covers an IR
    read off disk, which `readIR` brands without validating.

### Patch Changes

- fc8f3c9: Read a declaration's leading comments and decorators from the declaration, not from the file

  `readLeadingJsDoc` and `collectDecoratorNodes` ask the same question — _the run of siblings
  immediately before this declaration_ — and both answered it by reading the parent's whole
  child list and searching it for the declaration's own position.

  `children` and `namedChildren` are not field reads. Each unmarshals every child across the
  WASM boundary into a fresh JS object, and caches the result on one JS wrapper, so the next
  `node.parent` pays for the list again. The parent of a top-level declaration is the entire
  program: a file of N declarations paid O(N) per declaration.

  Both now walk backwards from the node with `previousSibling` / `previousNamedSibling`, which
  stops when the run ends — nearly always immediately, since most declarations carry neither a
  comment nor a decorator.

  Measured on one file of exported one-line functions, alternating between the two versions
  so machine drift lands on both arms (min of three runs each, whole `scan`, ms):

  | declarations | before | after | after (repeat) |
  | ------------ | ------ | ----- | -------------- |
  | 1,000        | 451    | 214   | 206            |
  | 2,000        | 1232   | 304   | 326            |
  | 4,000        | 12208  | 502   | 516            |

  The exponent is the claim, not the digits: doubling the declarations multiplied the old
  time by 2.7 and then 9.9, and the new one by about 1.5 both times — sub-linear, because a
  fixed ~200 ms of startup dominates at this size. A 1.5 MB file of ~18,000 declarations, the
  shape a generated API client or a Prisma type file has and comfortably inside
  `maxFileSizeBytes`, now extracts in about 1.9 s where it had been taking minutes.

  Two behaviour changes come with the rewrite rather than falling out of it.

  **A comment no longer ends a decorator run.** Tree-sitter treats a comment as a named node
  and puts it wherever it was written, including between two decorators or between the
  decorators and the `export` keyword. Stopping there let a `// biome-ignore` or a TODO detach
  `@Injectable()` from the class it decorates — silently, since decorators feed the framework
  classifier, so the Symbol came out with the wrong `extKind` rather than with an error.
  Comments are now skipped, the way `readCallArguments` already skips them. This also fixes
  the same shape inside a class body (`class C { @A() /* note */ m() {} }`), which had been
  losing its decorator since before this change.

  **The `export_statement` special case is gone.** The grammar's rule is
  `decorator* 'export' ['default'] declaration`, so a wrapped export's decorators are the
  declaration's own preceding siblings and the named walk steps over the keywords to reach
  them; the sweep-filter that used to handle it separately was doing the same job less
  precisely.

  Two placements the walk does not reach, pinned by tests here and closed in the change that
  follows: a decorator on a declaration with no wrapper to hold it (`@A() class C {}` at top
  level, or `export @A() class C {}`) is parsed as a _child_ of the declaration rather than a
  sibling, so it is not read.

- Updated dependencies [5c36d16]
- Updated dependencies [e2dab93]
- Updated dependencies [309f093]
- Updated dependencies [74aa475]
- Updated dependencies [fc8f3c9]
- Updated dependencies [630460f]
- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [060d7a5]
- Updated dependencies [74aa475]
- Updated dependencies [1e59445]
- Updated dependencies [c825c74]
- Updated dependencies [8ce6ed4]
- Updated dependencies [4c16cad]
- Updated dependencies [6d3d390]
- Updated dependencies [c3654c3]
- Updated dependencies [0b39623]
- Updated dependencies [da20510]
- Updated dependencies [baa6857]
- Updated dependencies [b8763eb]
- Updated dependencies [cafd4b8]
- Updated dependencies [667f9b7]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [dbdc8aa]
- Updated dependencies [836b05a]
- Updated dependencies [85ade16]
- Updated dependencies [14bdb6b]
  - @aburi/core@0.3.0
  - @aburi/types@0.3.0

## 0.2.0

### Minor Changes

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

- df2f3ec: Report why calls stay unresolved instead of dropping them silently.

  `docs/design/slice-view.md` §5.4 gives calls with `resolved: null` no `CallEdge`,
  so a Controller → Service pair whose link the resolver could not identify shows
  up as two unrelated singleton Slices. The behaviour is intentional and unchanged
  — what was missing is any way for a reviewer to tell that apart from a genuinely
  disconnected change. This implements the diagnostic surface
  `docs/design/call-resolution.md` §8.1 had specified but left unbuilt, and with it
  the previously unsatisfiable test criteria CR27 / CR28 / CR29 of §10.4.

  `resolveCallGraph` now classifies every unresolved call into one of the five
  §8.1 buckets — `local-scope`, `external`, `dynamic`, `ambiguous`, `no-match` —
  using a fixed precedence so an unchanged workspace always reports the same
  numbers. Which calls resolve, the `CallEdge[]` they produce, and the resulting
  `slices[]` are all byte-identical to before.

  Surfaces:

  - `aburi scan` and `aburi diff` print one stdout line, e.g.
    `calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · no-match 17)`.
    Zero-valued buckets are omitted. When the head IR predates the counter,
    `aburi diff` omits the line rather than printing misleading zeroes, and says so
    on stderr so the absence is not itself silent.
  - The `## 🧵 Slice View` section of `out/diff.md` gains a note when any member
    carries unresolved calls, plus a `⚠ N unresolved calls` marker on the affected
    members and singletons. Computed from the IR Symbols the diff already embeds —
    `aburi.diff.v1.json` is unchanged and `SliceRecord` gains no field.
  - `aburi explain <symbol> --debug-resolution` renders a `## Call resolution`
    table with the per-call bucket and, for `ambiguous`, the competing candidates.
    Per-call reasons are not persisted in the IR (§8.1), so the flag always
    rescans and is rejected alongside `--no-rescan` or `--ir`.

  No CI gate and no tuning knob was added: `--fail-on` is untouched, and
  `--debug-resolution` changes only what is printed
  (`docs/design/overview.md` §2, `slice-view.md` §14.7).

  Schema addition (non-breaking, additive per `ir-schema.md` §15.2): `Stats` grows
  an optional `callResolution` object holding `totalCalls`, `resolvedCalls`, and
  the five `unresolved` bucket counters. It is optional so documents produced
  before the field existed stay valid v1, but the current scan pipeline always
  emits it. New IR integrity invariant #15 re-derives all three numbers from
  `symbols[]`, so the census cannot drift from the document it describes.

  Public API additions:

  - `@aburi/types`: `CallResolutionStats` and `UnresolvedCallBuckets` (generated
    from the schema), plus the non-schema `UnresolvedCallBucket` /
    `UnresolvedCallDiagnostic` records. `CallCandidate` gains an optional
    `dynamicReceiver` flag — language plugins set it when the callee's receiver was
    an expression (`getRepo().save()`), which normalization otherwise collapses
    into something indistinguishable from a qualified name.
  - `@aburi/core`: `resolveCallGraph` returns `stats` and `diagnostics` alongside
    `symbols` / `edges`, accepts an optional `dynamicCallSites` input, and exports
    `makeCallSiteKey`. `ScanResult` gains `unresolvedCalls`.
  - `@aburi/markdown-projection`: `formatCallResolutionLine`, and an optional
    `unresolvedCalls` field on `ProjectSymbolExplainContext`. Explain output is
    byte-identical when it is omitted.
  - `@aburi/cli`: `DiffReport.callResolutionLine`, `ScanReport.callResolutionLine`
    / `ScanReport.unresolvedCalls`, and `ExplainOptions.debugResolution`.
  - `@aburi/lang-typescript`: reports `dynamicReceiver` for call, subscript, and
    parenthesized-expression receivers. Call target strings are unchanged, so no
    fingerprint moves.

- 2c5366d: Add `@aburi/framework-express`, a new framework plugin that classifies Express
  sources into five `framework:express:*` extKinds so Router-based apps and
  plain `app.get(...)` registrations can be scanned by Aburi.

  Recognised shapes (first-match-wins in the order listed):

  - `framework:express:router` — `const r = Router()` / `const r = express.Router()`
  - `framework:express:route` — `receiver.<method>(path, handler)` where `<method>`
    is one of `get` / `post` / `put` / `patch` / `delete` / `all`
  - `framework:express:middleware` — `.use(...)` with an arity-3 inline handler
    (or an identifier reference — flagged with `medium` confidence)
  - `framework:express:error-middleware` — `.use(...)` with an arity-4 handler
  - `framework:express:mount` — `.use(pathLiteral, identifier)` two-arg shape

  Confidence is `high` when the file imports `express` (ESM or CommonJS
  `require('express')`) and `medium` otherwise — the classification survives so
  the workspace projection still surfaces the shape, but consumers can treat
  medium-confidence rows as candidates for review.

  `@aburi/lang-typescript`: extends `extractSymbols` to promote module-level
  member-call expression statements (`app.get('/x', handler)`) into a new
  `kind: "call"` `SymbolCandidate` when the leaf method is in a small
  framework-registration whitelist. Symbol.id qnames are position-independent
  (`receiver__method[__pathSlug]__d<N>`) so IR fingerprints stay stable when
  leading imports or comments shift the source lines below.

  `@aburi/types`: adds `"call"` to the `SymbolKind` union and an optional
  `confidence?` field on `SymbolClassification` so framework plugins can express
  "matches the shape but I can't fully anchor it" (Express `.use(logger)` is
  `medium` unless the file imports `express`). Both fields are additive and
  optional — existing plugins (react / next / nestjs) remain unaffected.

  `@aburi/core`: the scan pipeline now threads `SymbolClassification.confidence`
  through to `Symbol.confidence`. When no framework classifier matches, or the
  winning classifier omits confidence, the value collapses to `"high"` at the
  `mergeFrameworkClassification` boundary so downstream code always sees a
  single, concrete `Confidence` encoding.

- f5cb552: Add `@aburi/framework-react`, a new framework plugin that classifies React
  sources into seven `framework:react:*` extKinds so React codebases (Vite / CRA
  / library authors — not just Next.js App Router) can be scanned by Aburi.

  Recognised shapes (first-match-wins in the order listed):

  - `framework:react:hook` — `/^use[A-Z]/` naming, with an extra `hook-call`
    `derivedBy` signal when the body calls another `use*` function
  - `framework:react:context` — `const X = createContext(...)` / `React.createContext(...)`
  - `framework:react:forward-ref` — `const X = forwardRef(...)` / `React.forwardRef(...)`
  - `framework:react:memo` — `const X = memo(...)` / `React.memo(...)`
  - `framework:react:provider` — PascalCase function whose returned JSX has
    `<X.Provider>` at its root
  - `framework:react:hoc` — `/^with[A-Z]/` naming
  - `framework:react:component` — PascalCase function whose body returns JSX
    (fallback)

  Detection is decorator-free: signals come from the symbol's name (leaf-of-qname
  regex), its `bodyNode` (tree-sitter walker looking for `jsx_element` /
  `jsx_self_closing_element` / `jsx_fragment`), and its `fullNode` (pre-order
  walk finding the outermost `call_expression` for the const-wrapper family). The
  plugin duck-types the tree-sitter node surface rather than depending on
  `web-tree-sitter` directly.

  `@aburi/lang-typescript`: extends `fileExtensions` and the internal
  `EXTENSION_GRAMMAR` map to accept `.js` / `.mjs` / `.cjs` (TypeScript grammar,
  permissively) and `.jsx` (tsx grammar, JSX-aware). This is what lets
  `@aburi/framework-react` classify React sources in plain-JavaScript codebases.

  `@aburi/cli`: `aburi init --with-suggestions` now maps a detected `react`
  framework to `@aburi/framework-react` alongside the existing `nestjs` /
  `nextjs` entries.

### Patch Changes

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [efe3cbd]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/core@0.2.0
  - @aburi/types@0.2.0

## 0.1.0

### Minor Changes

- 7ea4c8e: Introduce `@aburi/lang-typescript`, the first Aburi language plugin. Implements the full lang-plugin.md contract on top of `web-tree-sitter` and the pre-built typescript / tsx grammars from `@vscode/tree-sitter-wasm`:

  - **`parseFile`** — lazily initializes the WASM runtime once per process and caches every loaded grammar. Each call creates a fresh `Parser`, parses the file, collects recoverable syntax errors from the tree, and releases the parser before returning so the WASM heap stays flat across long scans (the discipline documented in lang-plugin.md §8.1).
  - **`extractSymbols`** — surfaces top-level functions / classes / interfaces / type aliases / enums / namespaces / variable-assigned functions, class instance and static methods (with `.` vs `::` separators), the reserved `<default>` sentinel for anonymous default exports, and nested namespace paths. Populates `Signature` with async / generator flags, positional inputs with names + types, outputs, sorted throws (both `throw new X()` statements and JSDoc `@throws {X}` tags), and type parameters. Extracts decorators with raw / arguments / line preserved (boundary defaults to false for framework plugins to override).
  - **`walkBody`** — emits guard / throw / return / loop / try / switch rules with the drop-list `isTrivialReturn` rule fully implemented (literal / identifier / member-chain / unary-of-trivial returns are dropped; `return f()` records the call but skips the rule). CallCandidate captures `target`, `line`, `argumentCount`, `inAwait`, `inNew`, and per-argument literal values.
  - **`normalizeAst`** — emits a positionless, comment-free, whitespace-free S-expression with identifier and literal values preserved. Feeds `syntaxFingerprint` in `@aburi/core`.
  - **`symbolDropHint`** — Category B hints for interface (`interface (data model)`), type alias, pure DTO, pure constants, and empty function body. Category A file patterns cover `**/*.d.ts` / `**/*.d.mts` / `**/*.d.cts`.
  - **Import extraction** — static named / default / namespace / bare / mixed imports, `export ... from ...` re-exports, and dynamic `import()` calls collapse into a normalized `ImportEdge[]`.

  Public API: `langTypescriptPlugin` (ready-to-register instance), `LangTypescriptPlugin` (class), `langTypescriptManifest`, `parseTypescriptFile`, `extractSymbols`, `walkBody`, `normalizeAst`, `extractImports`, `classifySymbolDropHint`, `TYPESCRIPT_FILE_DROP_PATTERNS`.

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
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/core@0.1.0
