# @aburi/cli

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

- c913783: Enforce the `SliceRecord.id` anchor derivation instead of trusting it.

  `docs/design/slice-view.md` §7.1 defines a Slice id as `"slice:" + members[0]`,
  but `aburi.diff.v1.json` only constrains it with `pattern: "^slice:"`. Neither
  the derivation nor the §8.2 ascending `members[]` order can be written in
  JSON Schema 2020-12 — both compare one property against another — so
  `{ id: "slice:foo", members: ["bar", "baz"] }` validated cleanly, and a reader
  that reconstructed the anchor from the id would name a Symbol the Slice does
  not contain. `computeSlices` also had no post-condition of its own: that
  `members[0]` is the lexicographically smallest member held only because
  `computeWeaklyConnectedComponents` sorts each component, one layer below the
  pass and invisible from it.

  The derivation now lives in exactly one function, and `computeSlices` validates
  every `SliceRecord` it builds before returning it — an empty `members[]`, a
  non-strictly-ascending `members[]`, or an `id` that is not `"slice:" +
members[0]` raises `DiffError` with the new code `slice-invariant-violated`.
  Emitted output is byte-identical to before; the check only fires on a producer
  bug. `docs/design/slice-view.md` gains §7.4 describing the three enforcement
  layers, §8.2 now states that the member order is strictly ascending and why,
  and §13.7 adds the test criteria SV23–SV25.

  Public API additions:

  - `@aburi/diff`: `sliceAnchor(record)` returns `members[0]` — the anchor — and
    never derives it from `id`, so no consumer has a reason to strip the `slice:`
    prefix. `sliceRecordViolation(value)` takes `unknown` and reports which
    clause broke as a `SliceRecordViolation` (`kind` / `subject` / `message`), so
    a validator can classify a verdict without parsing prose and cannot crash on
    the untyped documents it exists to reject.
    `assertSliceRecordInvariant(record)` is its throwing form.
  - `DiffErrorCode` grows `"slice-invariant-violated"` (code additions are
    non-breaking).
  - `@aburi/cli`: `classifyDiffError(error)` maps a `DiffError` onto the exit-code
    table. `slice-invariant-violated` now exits 1 as a `runtime-error` naming
    itself an Aburi bug, instead of exit 2 as a `config-error` that would send the
    reader searching `aburi.json` for a fault that is not there. Every other
    `DiffError` keeps its existing exit 2.

  `@aburi/core` documents the two output-ordering guarantees
  `computeWeaklyConnectedComponents` has always provided — each component sorted
  by ascending key, components sorted by their first element — since Slice View's
  anchor rule depends on the first of them. `@aburi/markdown-projection` replaces
  a `members[0] as string` cast with a real check; it still reads `members[0]`
  directly rather than importing `sliceAnchor`, keeping the renderer free of a
  dependency on the engine that produces what it renders.

  `schema/aburi.diff.v1.json` is unchanged apart from two `description` strings
  recording that `id` is derived and that consumers read `members[0]`; those flow
  into the generated `SliceRecord` doc comments in `@aburi/types`. No keyword was
  added to the schema file: v1 is frozen and published for validators outside
  this repository, and a non-standard keyword there would make every strict-mode
  validator reject the schema itself. The derivation check is instead registered
  as an Ajv keyword by the validating consumer — `packages/diff/test/schema.test.ts`
  layers it onto the shipped schema and rejects a wrong anchor the same way a
  wrong prefix is rejected.

### Patch Changes

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

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

- efe3cbd: Bound every LSP write so a stalled pipe or a dead server cannot park the
  enrichment pass.

  `createLspClient` raced every request against a deadline but awaited its four
  notifications — `didOpen`, `didClose`, `initialized`, `exit` — unguarded.
  JSON-RPC treats a notification as fire-and-forget, but the write still awaits the
  transport, so backpressure on a stdio pipe stalls it exactly the way it stalls a
  request. `didOpen` was the load-bearing case: it precedes the file's first
  request and therefore precedes every `fileBudgetMs` check the pass makes, so a
  stalled open meant the per-file budget could never fire and the scan sat on that
  one file indefinitely.

  Notifications now reuse the budgets the caller already has rather than adding a
  knob of their own — `schema/aburi.config.v1.json` and the generated config types
  are unchanged, and no new threshold had to be guessed at:

  - `didOpen` is bounded by `fileBudgetMs`. An open that spends the whole budget
    has left nothing for the enrichment it exists to enable, so the budget is
    already the right ceiling; exceeding it is an ordinary per-file fallback. The
    pass also re-checks the budget immediately after `didOpen` returns, so an open
    that came back healthy but slow no longer gets to issue a `documentSymbol`
    request the budget cannot pay for.
  - `didClose` is bounded by `requestTimeoutMs` — a single small write with no
    enrichment riding on it, where giving up sooner starts the next file sooner.
    A failure is logged at debug level instead of being swallowed whole; it cannot
    change what the file produced, so it moves no counter and escalates nothing.
  - `initialized` is bounded by `initializeTimeoutMs`, and a write that never
    lands now fails `initialize` rather than returning a handshake that never
    completed. It draws the full budget rather than the request's remainder, so a
    wholly unresponsive server can cost two `initializeTimeoutMs` before its
    language is disabled — 20 s at the default, where it was 10 s.
  - `exit` is bounded by the 1 s shutdown grace period that `shutdown` already
    used for its request and its SIGKILL timer, now a single named constant.

  Writes addressed to a server already known to have exited fail immediately with
  `server-disconnected`, notifications included. Previously only `request` did
  this: `didOpen` returned quietly, so after a server crash every remaining file
  was opened against a dead pipe, failed its single `documentSymbol` request
  (one short of the three needed to escalate), and was counted in `filesEnriched`
  with nothing enriched in it. Because the per-file streak reset on each such
  file, the language was never disabled and the CLI — which warns only on
  `filesFellBack > 0` or a disabled language — printed nothing at all. A crash
  mid-scan now falls back per file and disables the language after five, which is
  what makes the degraded run visible.

  `LspClient.didOpen` / `didClose` take a `timeoutMs` argument — matching
  `request(method, params, timeoutMs)` — and return `LspFailure | null` instead of
  `void`. `null` rather than `undefined` is what makes the contract enforceable:
  an implementation cannot claim a write succeeded by falling off the end of a
  function, which is precisely the bug fixed above. Timing counters are untouched:
  a notification is not a request, so `requestsIssued` / `requestsTimedOut` /
  `requestsFailed` keep their meaning and a failed `didOpen` surfaces as
  `filesFellBack`.

  Two unbounded waits one layer down are closed with the same reasoning.
  `SpawnedServer.killAfter` awaited the child's exit with no deadline, so a
  process wedged in uninterruptible I/O — which does not answer SIGKILL either —
  pinned `shutdown` forever; it now returns after at most two grace periods
  whether or not the child was reaped. And `EnrichmentInput.now`, declared as the
  injectable clock but never actually read, is now what the per-file budget goes
  through, defaulting to `performance.now`: the budget measures elapsed time, and
  a wall clock stepped backwards by NTP would make it unable to fire, reopening
  the hang from another door.

  `@aburi/cli` reads `ABURI_LOG_LEVEL`. It was parsed into `AburiEnv.logLevel` and
  then dropped, while the scan logger hard-coded `debug` and `info` to no-ops —
  so a debug line was unreachable in the shipped binary no matter what the user
  set. Default output is unchanged (`warn` and above); `ABURI_LOG_LEVEL=debug` now
  reaches the passes that emit at that level, the degraded-`didClose` line among
  them.

  `docs/design/lsp-enrichment.md` gains the notification bounds in §4.4, states in
  §6.1 that a `didOpen` which exceeds its bound or addresses a dead server is a
  per-file fallback (and names `filesFellBack`, replacing a reference to an
  `lsp-degraded` marker that never existed in the code), and adds test criteria
  LE19–LE23.

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [57064a8]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [efe3cbd]
- Updated dependencies [be40074]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/core@0.2.0
  - @aburi/diff@0.2.0
  - @aburi/markdown-projection@0.2.0
  - @aburi/types@0.2.0
  - @aburi/config@0.1.1
  - @aburi/plugin-registry@0.2.0

## 0.1.0

### Minor Changes

- 15e3e49: Add the Aburi command-line entry — `@aburi/cli` — that wires `@aburi/config`, `@aburi/core`, `@aburi/diff`, and `@aburi/markdown-projection` into the commands defined in `docs/design/cli-spec.md`. Ships with a `bin/aburi.mjs` shim and a testable `runCli(argv)` surface so integration tests can drive the CLI without spawning a subprocess.

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
