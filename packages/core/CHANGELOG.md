# @aburi/core

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

- f56e21b: Add Slice View clustering to `aburi diff`. Changed Symbols are grouped into
  weakly-connected components over the union of base and head call edges
  (Union-Find WCC), and rendered in `out/diff.md` under a new `## 🧵 Slice View`
  section positioned between `## 🔧 Logic changes` and `## ➕ Added`. Each Slice
  appears as a `### slice:<smallest-member-id>` heading with the member count
  and one bullet per member (short qname, status label, `file:line`, and a `↳`
  delta-axis summary). Singleton Slices collapse into one `<details>` "Standalone
  changes" fold. Empty `slices[]` omits the Markdown section entirely.

  Schema addition (non-breaking, additive per `ir-schema.md` §15.2): the
  `aburi.diff.v1.json` output now carries an optional top-level `slices` array
  whose entries are `{ id: string; members: string[] }`. The array is always
  emitted (empty when no Node-eligible change exists).

  Public API additions:

  - `@aburi/core`: `computeWeaklyConnectedComponents<TNode>` (generic Union-Find
    WCC utility) and `reconstructCallEdgesFromIR` (rebuilds `CallEdge[]` from a
    scanned IR's `Symbol.calls[].resolved` fields).
  - `@aburi/diff`: `computeSlices` + `SliceInput` — pure clustering function
    consumed by `buildDiff`.
  - `@aburi/types`: `SliceRecord` re-exported from the package barrel.

  No CLI flag was added and no `--fail-on` selector was extended, per
  `docs/design/slice-view.md` §11.4 / §14.7. The `slices[]` output is deterministic,
  idempotent, input-order-insensitive, and local under the guarantees enumerated
  in §10 of the same document.

### Patch Changes

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

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

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

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/types@0.2.0

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

- 115be7a: Add `packages/e2e-integration` (with its `fixtures/nestjs-billing/` project) — the end-to-end suite
  for the v0.1 release.

  ### Fixture

  `fixtures/nestjs-billing/` (inside the package) is a handwritten NestJS-shaped billing service (10 `.ts`
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
