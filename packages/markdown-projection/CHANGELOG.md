# @aburi/markdown-projection

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

- f73eb46: Name the files neither revision analysed, in the diff rather than only on stderr

  `SymbolChange.status: "unknown"` covers a file **one** scan lost: the other document still holds
  its Symbols, the matcher has leftovers, and each one gets a status saying the answer is missing.
  A file skipped on **both** sides leaves no Symbols anywhere, so there is no leftover, no entry,
  and the diff said nothing at all:

  ```
  base, vendor/bundle.js skipped (over-size) → no Symbols from it
  head, vendor/bundle.js skipped (over-size) → no Symbols from it

  summary:      +0 -0 ~0 ↔0 ⤴0
  diff.json:    nothing
  diff.md:      nothing
  exit:         0
  ```

  Which is indistinguishable from having compared the file and found it unchanged.

  **This is the ordinary case, not the exceptional one.** Most skip reasons are deterministic
  properties of the file rather than of the revision — `over-size` on a generated bundle,
  `unroutable` on a language no loaded plugin claims, `parse-failed` on a file broken since before
  the branch was cut. So a workspace with a standing blind spot got a clean-looking diff on every
  pull request while a whole directory sat outside the comparison.

  `aburi diff` already named those paths on stderr. That is a cover note, not the artifact: a
  `diff.json` handed to a bot, or a `diff.md` pasted into a review, carried no trace — the same gap
  `stats.skippedFiles` closed on the IR side.

  **What was added**

  `DiffResult.notCompared[]`, one entry per path both skip lists hold, carrying `baseReason` and
  `headReason`, sorted by path. `diff.md` gains a `## 🚫 Not compared` section beside Unknown.

  - **A document-level field rather than a new status.** The diff has nothing to say about such a
    file at the Symbol level, because it has no Symbols from it on either side. The honest
    statement is about the run.
  - **The intersection, not the union.** A one-sided loss is already reported as `unknown`;
    listing it here as well would count one loss twice in two vocabularies that mean different
    things.
  - **Both reasons, never one.** They can differ — `parse-timeout` at the base and `over-size` at
    the head is one file that timed out once and is permanently too large — and the pair is what
    tells a reader whether a re-run is enough. The Markdown collapses them to one phrase only when
    they agree.
  - **No summary counter.** `unknown` and `depsUnknown` complete a census: they correct the
    counters beside them, which are undercounts by exactly that much. These files contributed no
    entry to any array on either side, so there is nothing to correct — the field scopes the
    document rather than qualifying a count.

  **Emitted unconditionally, empty array included.** The IR's convention for a field like this is
  Class B — omit the key when empty; the diff's is the opposite, per
  `docs/design/diff-algorithm.md` §10.1. An IR reader can fall back on `totalFiles - parsedFiles`
  to tell "nothing was lost" from "this writer could not say"; a diff reader has nothing to fall
  back on, so the writer says it. Schema-optionality covers only documents written before the field
  existed, and the Markdown section is omitted for those rather than reporting a clean run.

  **Not in scope.** `--fail-on` gains no token. A workspace with a permanent over-size bundle would
  trip a bare one on every pull request, which is an argument for a threshold rather than a flag,
  and the same question is already open for the dependency side.

  Nor does an entry carry a `detail`. Ref mode could supply one — it keeps both `ScanReport`s, and
  each `skipped` entry there has the size, the elapsed or the message a plugin refused the file
  with — but file mode runs no scans and never could, so the field would be present or absent for
  the same workspace depending on how the diff was invoked. It is also what the IR refuses to
  persist for the same reason (`ir-schema.md`, `SkippedFile`): an `unreadable` detail is an OS
  error message carrying an absolute path, and a canonical document whose bytes depend on where
  the repository was checked out is not byte-stable. This field carries exactly what
  `stats.skippedFiles` persists, which is what makes it available from both modes.

  Every `diff.json` gains the key, so a byte-exact or snapshot comparison against one written by an
  older version will differ.

  Verification: 9 cases in `packages/diff/test/not-compared.test.ts`, five ajv instance cases, one
  canonical byte-stability case that reverses both skip lists, five projection cases, and the CLI's
  symmetric-loss case extended to read the artifact it wrote rather than the value it returned. The
  primary fixture skips the same path for _different_ reasons on the two sides, because every
  fixture where they agree is blind to the two being swapped.

- 4c2d5aa: Record what the scan lost, and stop calling it removed API

  A file the scan gave up on left no trace **inside** the IR. `ScanResult.skipped` and
  `ScanResult.extractionFailures` are siblings of `ir`, and `writeCanonicalIR` serialises `ir`
  alone, so `out/aburi.ir.json` said only that `parsedFiles` was below `totalFiles` — which is
  equally true of an over-size file, a timed-out one and a withdrawn one, and names none of
  them.

  The next `aburi diff` then read every Symbol in that file as deliberately deleted API:

  ```
  scan @ main       → 400 symbols
  scan @ PR branch  → src/route.ts withdrawn, 380 symbols
  aburi diff        → 20 symbols "removed"
  --fail-on removed → trips, reporting an API deletion nobody made
  ```

  The scan's exit code was the only signal, and an exit code does not travel with the
  artifact. `parse-timeout` was the sharpest case: whether a file times out depends on how
  loaded the machine was, so the same commit produced the phantom on one run and not the next.

  ## `stats.skippedFiles[]`

  The Document now names them: `{ path, reason }[]`, sorted by path, one entry per file the
  scan stopped working on, whatever stopped it. The name is the one `component-detect.md`,
  `drop-list.md` and `lang-plugin.md` have each pointed at as planned.

  Class B per `ir-schema.md` §1.1 — the key is omitted when nothing was lost, so its presence
  answers "did this run drop anything" on its own, and absence _with_ `totalFiles > parsedFiles`
  identifies a document written before the field rather than a clean run.

  **No `detail`.** The scan carries one per entry — the size, the elapsed, the message a plugin
  refused the file with — but the `unreadable` detail is an OS error message containing the
  **absolute** path, and a canonical document whose bytes depend on where the repository was
  checked out is not the byte-stable artifact everything downstream assumes.

  Integrity **invariant #21**: when present, `skippedFiles.length === totalFiles - parsedFiles`
  and no path appears twice. This is a **read-side** check — inside Aburi's own scan both sides
  reduce to the same sum of the same two counts, so it cannot fire on a document Aburi wrote.
  What it guards is a document arriving through `readIR`, hand-edited or from another generator,
  that `aburi diff` is about to read to decide an absent Symbol is a loss rather than a deletion.
  Conditional on presence, because a document that predates the field cannot satisfy it and its
  absence is itself the answer.

  It does not cover a file that parsed successfully and yielded no Symbols: counted in
  `parsedFiles`, in no array, satisfying the check, and its Symbols still reported as removed.
  Withdrawal takes a plugin saying so, so a plugin that swallows its own error and returns an
  empty Symbol list withdraws nothing.

  `workspace.md` gains a "Files not analysed" section grouping the paths by reason, so a reader
  holding only the Markdown sees the same thing.

  ## `status: "unknown"`

  `aburi diff` reads that list. A leftover Symbol whose `source.file` the _other_ document never
  analysed is no longer `removed` (or `added`) but `unknown`, carrying `absentFrom` — the
  document that lost the file, so `head` reads as "this may still exist" and `base` as "this may
  not be new" — and the skip `reason`, which is what decides the reader's next move.

  Three properties this rests on:

  - **Classified after the five matching stages, never before.** A Symbol that moved _out of_ a
    lost file into a file the other document has is matched by stage 3 or 4 and stays `moved` —
    that document holds real evidence for it. Filtering the base list up front would throw the
    answer away.
  - **Both directions.** A file fine at head and withdrawn at base makes phantom `added` entries
    exactly as the reverse makes phantom `removed` ones.
  - **`dropped` leftovers keep their counters.** They produce no `symbols[]` entry on either
    side today and nothing gates on them, so `droppedAdded` / `droppedRemoved` still count them
    rather than gaining entries where there were none. Stated rather than silently different.

  A status of its own rather than the alternatives: suppression hides a Symbol that may
  genuinely have been deleted, and `removed` plus a flag shows an API deletion to every reader
  that does not know to look — including `--fail-on removed`, which is the whole reason the
  phantom mattered.

  `SymbolChange` gains a member, which is breaking for an exhaustive `switch` over `status`.
  `Summary.unknown` is optional rather than required, so a diff written before the counter stays
  schema-valid; `--fail-on unknown` counts the entries rather than reading it, so the gate
  answers about the document rather than about which writer produced it.

  ## What a reader sees

  ```
  ⚠ head IR reports 3 file(s) it did not parse but has no stats.skippedFiles to name them, …
  ```

  when a document dropped files but predates the field. `buildDiff` cannot invent the list —
  inferring it from `totalFiles > parsedFiles` would attach the doubt to whichever Symbols
  happened to be missing — so it reports what it can see, and the CLI says what it could not
  check. Both sides are examined.

  `diff.md` gains an `❔ Unknown` section directly after Removed, naming the file, the side that
  lost it and why. **Both** summary lines — the word form in `diff.md` and the glyph form on
  stdout — grow `· ?N unknown` when there is one, and neither carries a permanent `?0` when there
  is not. The glyph line matters most: with `stats.skippedFiles` present on both sides the stderr
  warning cannot fire, so it is the only place a run that lost a file says so without
  `--fail-on unknown`. `aburi diff` now renders it through
  `@aburi/markdown-projection`'s `projectDiffSummaryLine` rather than a byte-identical private
  copy, which is how the two came to disagree.

  `workspace.md`'s header reports `parsedFiles` beside `totalFiles` whenever they differ, so a
  document that lost files but predates `stats.skippedFiles` no longer renders byte-identically
  to a clean scan — the projection is a pure function with no stderr to fall back on.

  A file skipped by **both** scans produces no `unknown` entry: neither document holds Symbols
  from it, so the matcher has no leftover to classify. Most skip reasons are deterministic
  properties of the file, which makes symmetric loss the ordinary case rather than the
  exceptional one, and the diff would otherwise look exactly like one that compared the file and
  found it unchanged. `aburi diff` names those paths on stderr, capped. Representing them inside
  `diff.json` is left open: the only thing to say about such a file is that neither side read it,
  which is a statement about the run rather than about a Symbol.

  ## Not closed by this

  `aburi scan` still exits `0` when a plugin refuses every file in the workspace — the document
  now says so, but nothing gates on it.

  `aburi explain` and `aburi diff` still discard the incident report of the scans they run
  themselves, so a Symbol in a file the scan refused is answered with `No matches` rather than
  with a reason.

  `dependencies[]` is projected from the call graph, so a lost file's Symbols take their edges
  with them and `summary.depsRemoved` reports exactly the confidently-wrong deletion this change
  fixed for `symbols[]`. `unknown` is a `symbols[]` status only.

  Each of the three is tracked as its own issue.

- 37715cd: Stop reporting a lost file's dependency edges as deletions

  `SymbolChange.status: "unknown"` stopped `aburi diff` reporting a withdrawn file's Symbols as
  deleted API. `dependencies[]` had the identical defect and was untouched by it.

  `IR.dependencies` is projected from the resolved call graph, so a Symbol that never reached a
  document takes every edge it participated in with it. `diffDependencies` compared the two arrays
  by `(from, to, via)` and reported whatever the head lacked as removed:

  ```
  base                       → gone.ts#gone → kept.ts#kept, kept.ts#kept → gone.ts#gone
  head, src/gone.ts withdrawn → (neither edge)

  summary.removed:     0     ← correct since stats.skippedFiles landed
  summary.depsRemoved: 2     ← two dependencies nobody deleted
  ```

  The second edge is the half that is easiest to miss. `kept` is in both documents, so the edge
  reads as a call the author removed; it disappeared because the _callee's_ file was never read.

  An edge one document holds is now `unknown` when the other never analysed the file an endpoint
  lives in, carrying `absentFrom` on the same reading as the Symbol side and `lostFiles[]` naming
  the files with the reason each was skipped.

  **Where it differs from the Symbol side, and why**

  - **The endpoint's file comes from the document that holds the edge**, read out of
    `symbols[].source.file` rather than out of the id's path segment. That is the same space
    `stats.skippedFiles[].path` is in and the same space Symbols are classified by, so a Symbol
    reported `unknown` and the edges it took with it cannot disagree about which file went
    missing. Parsing the id would have been a second answer to the same question, and nothing in
    the schema forces the two to agree.
  - **`lostFiles` is a list where `SymbolUnknown` carries one `reason`.** An edge has two
    endpoints: they can sit in two files skipped for two different reasons, one saying re-run and
    the other saying fix something. An intra-file edge collapses to the single file it lost.
  - **Component-level edges are never reclassified.** A Component is an aggregate over roots and
    has no file to lose, so a component endpoint is simply absent from the lookup — no special
    case, and now stated in `docs/design/diff-algorithm.md` §6.2.1 rather than left to be
    rediscovered as an asymmetry.

  A direction or effect flip stays an added + removed pair, with no loss check. Not because
  neither document lost an endpoint file — nothing forbids a path from being both a `source.file`
  and a skipped one — but because both documents _hold_ the edge, so neither is silent about it,
  and `unknown` explains silences.

  `dependencies.unknown[]` and `summary.depsUnknown` are schema-optional only so a diff written
  before they existed stays valid. A current writer always emits both, empty array and zero
  included — unlike the IR's `stats.skippedFiles`, no arithmetic elsewhere in the document would
  let a reader tell "nothing was unknown" from "this writer could not say".

  `diff.md` gains an `### Unknown — the other revision never read one end` group under Dependency
  changes, each line naming the file and the reason. It is not split by level the way the added and
  removed groups are, because only a Symbol endpoint has a file to lose.

  **Not in scope.** `--fail-on` has no dependency token — none exists for `depsAdded` or
  `depsRemoved` either — so the harm here was to `diff.json` consumers and to the Dependency
  changes section, not to the CLI gate. Adding a dependency gate family is its own decision. And a
  file **both** revisions skipped still produces nothing: neither document holds an edge from it,
  so there is no leftover to classify, which is the deps-side face of a gap `aburi diff` reports on
  stderr and the artifact does not.

  `diffDependencies`' new `sides` parameter is **required**. Optional, it would have restored the
  defect silently: a two-argument call classifies every edge into a lost file as a deletion again
  while still writing `unknown: []`, which this schema defines as "nothing was unknown" rather than
  "nobody looked". A caller with no skip list says so by passing a side view whose `lostFiles` is
  empty. `dependencySideView(ir)` is exported to build one, and is the single construction site —
  `buildDiff` feeds the same object to its own Symbol classification, so the two cannot drift.

  For a direct caller the classification of any edge is unchanged when the side views carry no
  losses; the returned object gains an always-present `unknown` array it did not have before, which
  a deep-equal or a snapshot will see.

  Verification: 18 tests in `packages/diff/test/unknown-dependencies.test.ts`, four ajv instance
  tests, a canonical byte-stability case that reverses the input order, and four projection tests.
  Two of the diff tests exist because the rest of the file could not see the difference between
  resolving an endpoint through `source.file` and parsing its id: every other fixture has the two
  equal by construction, so they use a Symbol whose id says `src/old.ts` and whose `source.file`
  says `src/actual.ts`, in both directions.

### Patch Changes

- 39ef5b9: Render the `modified` bucket of every `SymbolDelta` array

  `ArrayDelta` has three buckets and `@aburi/diff` fills all three — `differentiate` routes
  an element whose identity key matched but whose content changed into `modified` — while
  the projection read it in exactly one place, for decorators. Everything else was dropped:

  - a rewritten guard condition (`rules.modified`),
  - an effect whose confidence was downgraded (`effects.modified`),
  - a call that stopped resolving (`calls.modified`),
  - and, because `signature.inputs` keys on `${index}:${name}`, every parameter whose type
    changed — the most common breaking API change in TypeScript.

  Those symbols rendered as a heading and a file link with no body, so the CI gate fired on
  a change whose explanation was blank.

  `signature.outputs` and `throws` gain the same treatment, though `diffStringList` and
  `diffStringSet` never populate those buckets — they are rendered so a document from another
  producer is not silently truncated, not to close a live gap.

  `signature.inputs` added / removed now name the parameter and its type instead of reporting
  a count, and a delta that renders nothing while claiming a change says so in one line
  rather than leaving the section empty. That covers `syntaxChanged` as well, because
  moved+changed entries render regardless of which flag is set and a syntax-only move is the
  case least likely to carry field-level detail.

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

- 57064a8: Emit diff.md section headings in English only (`## ⚠ API changes`, `## 🔧 Logic
changes`, `## 💧 Dropped changes`, `## 🎨 Syntax-only changes`) and use
  `N entries` in fold-out summaries. Previously these four headings mixed
  Japanese words; headings are stable identifiers CI and reviewers may match on,
  so this is a breaking change for anyone grepping the old strings.
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

- 7a6cfeb: Add the deterministic Markdown projection engine — `@aburi/markdown-projection` — that turns any `aburi.ir.v1` document (and, optionally, an `aburi.diff.v1` output) into human + AI-readable Markdown views, following `docs/design/markdown-projection.md` end to end.

  ### Projections
  - **`projectWorkspace(ir)`** (§4 — `workspace.md`) — Managers / Languages / Symbol counts header, Components table (with per-component symbol counts), `graph LR` mermaid dependency diagram with an always-attached text fallback and a `MERMAID_NODE_LIMIT` (100) auto-fallback for oversized graphs, and the top-`EFFECT_SURFACE_TOP_N` (10) effect surface table sorted by count.
  - **`projectComponent({component, symbols, dependencies})`** (§5 — `components/<id>.md`) — Component header (Roots / Languages / Frameworks / Symbols counts), Public API list, Dependencies list, `## Symbols` grouped by file with §3.2 ordering (`startLine` primary, `id` tiebreaker), and a `## Dropped` `<details>` fold-out (§3.6). §5.3 section-omit rules are applied: empty `decorators` / `signature: null` / empty `rules|effects|calls` skip the row, zero fingerprints skip the `<sub>` line.
  - **`projectSymbolExplain(symbol)`** (§7 — `aburi explain`) — Stand-alone Symbol view with dedicated `## Boundary` / `## Decorators` / `## Signature` / `## Rules` / `## Effects` / `## Calls` / `## Derived by` / `## Fingerprint` sections. Dropped Symbols fall back to a 3-line summary (name + drop reason + IR-contract note).
  - **`projectDiff(diff)`** (§6 — `diff.md`) — Ten sections in importance order: `## ⚠ API changes` / `## 🔧 Logic changes` / `## ➕ Added` / `## ➖ Removed` / `## 🔀 Moved + Changed` / `## 🔀 Moved` (fold-out) / `## 🧱 Component changes` / `## 🔗 Dependency changes` / `## 💧 Dropped changes` (fold-out) / `## 🎨 Syntax-only changes` (fold-out). Changed entries are routed by delta priority (`apiChanged` > `logicChanged` > `syntaxChanged`) into exactly one of the top three sections; `moved+changed` entries are surfaced both under `Moved + Changed` and their delta-priority section by design (§6.2), so a reviewer can see the move context and the impact simultaneously. Empty sections are dropped entirely so PR comments stay tight.
  - **`projectDiffSummaryLine(diff)`** (§6.3) — Compact `+A -R ~C ↔M ⤴MC` string for CLI stdout.

  ### Confidence badges & shared formatters
  - `confidenceBadge` (§3.5) — `high` → no badge, `medium` / `low` → `⚠ <level>`.
  - `signatureLine`, `ruleRow` (§5.6 seven RuleType shapes), `effectRow` (§5.7), `callRow` (§5.8), `fingerprintLine` (§5.9), `decoratorRows` (§5.4), `codeFragment` (§3.4 inline vs. fenced) — pure text primitives reusable across projections.

  ### Sanitisation (§8)
  - `sanitizeSymbolId(id)` — `:` / `/` / `#` / `.` → `-`, consecutive dashes collapse, leading/trailing dashes trim.
  - `collisionSuffix(id)` — deterministic `SHA-256(UTF-8(id))` first 3 bytes as 6-char hex.
  - `withCollisionSuffix(id)` — always-append form.
  - `assignSymbolFilenames(ids)` — batch resolver: keeps base names on unique inputs, appends `-<hash>` to both sides of a collision.

  ### `--fail-on` formatter
  - `FailOnClause` — discriminated union `{kind: "bare"} | {kind: "threshold", comparator, count}` so a threshold clause cannot be constructed with only half its shape. Sub-directions `dropped-toggled:to-dropped` / `dropped-toggled:to-kept` are supported.
  - `formatFailOnClause` → argument-form string (`changed:>10`).
  - `formatFailOnTriggered(clause, observed)` → stable CI-log phrasing.
  - `evaluateFailOn(clause, summary, breakdown?)` → `{triggered, observed}` with strict `>` / `>=` / `==` / `<=` semantics.

  ### Tests

  37 tests across `test/{mp-properties, sanitize, fail-on}.test.ts` cover MP1..MP12 verifiables, sanitisation + collision (MP9), and every `--fail-on` comparator / bare-status combination.

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
