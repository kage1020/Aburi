# @aburi/types

## 0.4.0

### Minor Changes

- be8e2b9: One Symbol per declared entity, however many declarations wrote it

  A getter beside its setter, an overload beside its implementation, and a reopened namespace or
  interface each made `extractSymbols` emit two SymbolCandidates under one id. Integrity invariant 1
  (`ir-schema.md` §14) refuses that, and it is checked once over the finished document rather than
  per file — so `class Box { get value() {} set value(n) {} }` did not cost its own file, it ended
  the run and took every other file's Symbols with it.

  TypeScript models all three the same way: one entity, several declarations. So does extraction
  now. The first declaration claims the Symbol and every scalar on it; later declarations of the
  same id contribute their `derivedBy` and their body instead of becoming a second Symbol. First
  wins because legal source already orders them — TypeScript requires the class or function to
  precede the namespace merged into it, and requires a merge's declarations to agree on whether
  they are exported.

  Two constructs are handled before that rule rather than by it, because it would answer them
  wrongly:

  - **An overload declaration is skipped.** A `method_signature` in a class body declares nothing
    the implementation beside it does not, and it is written _first_ — so folding it as the leading
    declaration would report the member as body-less and give it the overload's parameter types.
    Top-level overloads have always behaved this way (`function_signature` is not in the statement
    switch); a class matches now, so the same source does not answer differently depending on where
    it is written.
  - **An accessor pair is led by the getter.** A property's type is what reading it answers, so
    taking the setter's signature would report the member as `(n) => void`.

  `SymbolCandidate` gains `mergedDeclarations?: MergedDeclaration<TNode>[]`: the further
  declarations, in source order, each carrying both its `bodyNode` and its `fullNode`. Without the
  field, folding a pair would drop the setter's body — a `set password(v)` that hashes the value has
  effects. Without `fullNode` on the entry, a reopened `enum E {}` would fingerprint as though the
  second declaration had never been written, because an enum candidate has no body at all. Only the
  bodies reach `walkBody`, which is what keeps a merged namespace from being walked twice. The key is
  absent, never empty, on a Symbol with one declaration, so the single-declaration path is untouched
  and no existing fingerprint moves.

  `derivedBy` and `decorators` join the same way. A lost `boundary` decorator is not cosmetic:
  `interface P {}` written above `@Controller() class P {}` is legal, so the declaration that claims
  the Symbol is the one carrying none.

  Two drop rules were reading one declaration where they should read all of them, and one was reading
  decorators nowhere. `classifySymbolDropHint` now honours a boundary decorator for every kind rather
  than only for classes — core's `decideSymbolDrop` answers `null` on a boundary and then defers to
  this hint, so an unguarded arm here is the one that decides. `classifyClassBody` reads class bodies
  only, so a merged `interface C {}` does not contribute members the class does not have.

  Two namespace fixes come with it, because folding a reopened namespace requires reaching one.

  An unexported `namespace` at statement position is parented under an `expression_statement`, which
  the statement switch never looked through — so every unexported namespace lost its own Symbol
  _and_ everything declared inside it.

  And a dotted `namespace A.B {}` is sugar for `namespace A { namespace B {} }`. Reading the dotted
  text as one qualified-name segment is what the id builder refuses, and the throw cost the file every
  Symbol it had; it declares one Symbol per segment now, with the body under all of them.

- 3774de6: Free the parse tree the language plugin hands over

  A WASM parse tree is not something the JavaScript garbage collector can reach. `lang-plugin.md`
  §8.1 says so and names the consequence — `RangeError: WebAssembly.Memory()` after some thousands
  of files — but told the plugin to free a tree it had already given away, and nobody on the other
  side picked it up. `@aburi/core` contained no `delete` call at all, so every file that parsed
  successfully left its tree in the WASM heap for the rest of the run.

  `LanguagePlugin` gains an optional `releaseTree(tree)`. `runFilePipeline` calls it once per
  non-null tree, in a `finally` that covers every way out of the file: the success path, a file
  withdrawn by a `recoverable: false` error, a file abandoned on `parseTimeoutMs`, and a throw out
  of `extractSymbols`, `walkBody` or `normalizeAst`. A plugin whose trees are ordinary
  garbage-collected objects omits the method and nothing changes for it.

  The core is the only side that can do this. `parseFile` gives the handle away at step 1 and the
  tree stays live until `normalizeAst` has read the last node out of it — a plugin that deleted
  its own tree on the way out would be handing back something already dead. The one place the
  plugin still frees it is a `parseFile` that fails _after_ parsing, where the caller never
  receives the handle.

  A release that fails is recorded rather than propagated. It runs in a `finally`, so a throw
  there would silently become the file's outcome — replacing the diagnostic a failing file was
  already carrying, and turning a file that produced a perfectly good set of Symbols into an
  extraction failure. The record is structural: `ScanResult.treeReleaseFailures` names the
  plugin, the file and what went wrong, because a leak is silent until the run dies of it, and
  by then it presents as `RangeError: WebAssembly.Memory()` charged to whichever unrelated file
  was being read when the heap ran out. `ScanReport` carries it to the CLI, which prints it
  grouped by plugin with what the leak costs. It moves no exit code: every one of those files is
  in the IR, so the artifact describes the workspace completely.

  A `releaseTree` declared as something other than a function is recorded there too, in its own
  words — a contract violation is deterministic and fixable in a line, and reading it through the
  same `TypeError` catch as a parser failure would describe it as one. A `null` `releaseTree` is
  read as "nothing to free", the way the optional call it replaced did.

  `@aburi/lang-typescript` implements it as `tree.delete()`, and is exported with `satisfies` so
  the method stays required on the exported type.

- ba9e505: `stats.lspEnrichment` says how many receiver hints the typed tier produced, used, and threw away

  `stats.lspEnrichment` counted requests and files and nothing about answers, so the one number a
  reader reaches for — did turning LSP on buy anything? — was not in the document. A hover that
  comes back on time carrying nothing this pass can read is a healthy row in every counter there
  was: it lands in `requestsIssued`, in neither failure counter, it resets the consecutive-failure
  tally, and its file still counts in `filesEnriched`. `requestsIssued: 40, requestsFailed: 0`
  described a run that resolved forty extra call sites and a run that resolved none, and §6.2 keeps
  errors out of the IR, so nothing else recorded the difference either.

  Three counters now do. `hintsProduced` is the hovers read all the way to a callee Symbol,
  `hintsConsumed` the call sites the resolver turned into an edge, and `hintsRejected` the five
  places in between where a hint is lost — `unparseableHover`, `ownerClassNotFound`,
  `memberNotFound` on the enrichment side, `kindMismatch` and `targetDropped` on the resolver's.
  Two sums hold and neither crosses the halves: every hover that came back without a failure is
  either produced or in one of the first three buckets, and every call site that found a hint at
  its key is either consumed or in one of the last two. A hint the untyped tier made unnecessary is
  in neither, which is the ordinary shape of a healthy scan rather than a fault.

  The three are additive optional fields on `LspEnrichmentStats` in `aburi.ir.v1`, Class B per
  `ir-schema.md` §1.1: the pipeline writes all of them whenever it writes the record, with
  `hintsRejected` carrying five zeroes rather than being omitted, so absence means the document
  predates the counters. A new `LspHintRejections` definition holds the buckets.

  Neither sum is checkable from the finished document, and §7.2 now says so rather than reading
  like an integrity invariant: `requestsIssued` also carries a `documentSymbol` per file, so the
  hover count the producer identity balances against is not an IR quantity, and the call sites that
  found a hint at their key are recorded nowhere. The tests hold both sums instead.

  The two halves are written by two passes, and the second cannot reach the first: the resolver
  runs after `enrichWithLsp` has returned. `ResolveCallGraphResult` therefore carries a new
  `lspHintUsage` — what the LSP tier consumed and what it declined — rather than the resolver being
  handed a stats builder it would otherwise depend on having, and `withHintUsage` folds the two
  together. `enrichWithLsp` returns the producer half as `LspProducerStats`, whose three counters
  are required where the IR type has them optional, so a caller assembling the passes itself is
  told by the type that `withHintUsage` is what finishes the record. Without that fold
  `hintsConsumed` and the resolver's two buckets stay at `0`.

  `aburi scan` prints the three totals when a run produced or refused a hint, so the question the
  counters answer does not require reading the IR.

### Patch Changes

- 203ea78: Read the three import forms that lost their dependency edge

  `import x = require('./m')`, an `import()` behind a magic comment, and an `import()` whose
  specifier is a template all produced no `ImportEdge` and no diagnostic — a file importing only
  through `require` looked import-free, and the calls through the missing binding fell out of
  relative resolution into the `no-match` bucket with nothing saying why.

  Each missed for its own reason. A require-equals hangs its specifier off an
  `import_require_clause` rather than the statement's `source` field, so the reader found
  nothing. A magic comment is a _named_ node, so the first argument of `import()` was the comment
  rather than the specifier. A template is a `template_string`, not a `string`, so the literal
  reader refused it.

  The require-equals edge is a **namespace** edge — `symbols: "*"` with the binding on
  `namespaceBinding` — and not the default binding it superficially resembles. `x` names the
  module object the way `import * as x from './m'` does, and call resolution acts on the
  difference: the namespace arm strips the head off `x.foo()` and looks for `foo` in the target
  file, where a `symbols: ["x"]` edge would send it looking for `x.foo` there, which the target
  does not have. `dynamic` is false because the field means "written as `import()`" and this
  form is not — and because both loops in `callgraph.ts` that read a file's edges skip a
  dynamic one, the value is also what keeps this import in reach of call resolution.

  A clause that did not parse is not read at all. The grammar admits nothing but a string
  literal for the specifier, so `require("a" + b)` is a syntax error — but error recovery
  leaves the operand it could read as a direct child of the clause with the `source` field
  attached, and reading it would answer `a`. `require('./m', 'y')` would answer the second
  argument.

  A template _with_ a substitution stays computed and stays silent, which is the boundary this
  change is careful about: joining a substituting template's fragments would answer `"./"` for
  `` `./${p}` `` — an edge to a module the author never named, and a worse answer than none.

  An empty specifier written in either new form (`import x = require("")`, `import(`)``) goes
  through the same gate as `import("")` and is reported as the empty specifier it is.
  `firstNonCommentChild` moves to `ast-helpers.ts`, where the decorator reader takes it too;
  `imports.ts` drops its private `findChildByType`, a duplicate of `ast-helpers`' `findChild`.

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

- 8ce6ed4: Record a filename Aburi cannot build an id from, instead of ending the scan on it

  `discoverFiles` called `toPosixRelative` outside any `try`. That constructor runs the **Symbol
  id** path grammar, which refuses `:` and `#` — both legal POSIX filename characters, and `#`
  legal on Windows and macOS too. One such file anywhere in the tree threw a `CoreError` naming the
  id constructor, and the whole walk died with it. Further down that same loop, a file that cannot
  even be `stat`ed is recorded on `skipped[]` and the walk continues.

  Both are "one file cannot be handled". They now reach the user the same way:

  ```
  ⚠ 1 file(s) contributed no Symbols: unroutable=1
  ⚠ unroutable (1) — no route into the IR exists for them, decided before either was read. …
      src/od#d.ts: its path segment "od#d.ts" contains "#", which a Symbol id is split on, so nothing declared in this file could be given an id
  ```

  **The Document names it.** `stats.skippedFiles[].path` is held to the shared path rule
  (integrity #10), which admits both characters — only the _id_ grammar refuses them. So the file
  is counted in `totalFiles`, excluded from `parsedFiles`, and listed by path, and everything built
  for lost files answers honestly with no change: `aburi explain` says the IR never analysed it, and
  `buildDiff` puts it in `notCompared[]` when both revisions lost it.

  `@aburi/types` is released with it: the reason's description in `aburi.ir.v1.json` is mirrored
  into `packages/types/src/generated/ir.ts` by codegen, and that package is published. Only
  descriptions changed, so the bump is a patch.

  **Reason: `unroutable`, generalized.** Two producers, one meaning — _no route into the Document
  exists for this file, decided before it was read._ The router refusing an extension and the id
  grammar refusing a name are the same answer with different causes; the skip `detail` says which,
  and a reader with only the Document can tell from the path, since the second cause is visible in
  it and `detail` is deliberately not projected. A distinct `unnameable` would be the better model and is not available: `reason` is a
  closed `enum` in `aburi.ir.v1.json` and, by `$ref`, in `aburi.diff.v1.json`, so a document
  carrying a new value is rejected by any validating reader. Recorded as a v2 shape in
  `ir-schema.md` §15.4 with that reasoning.

  **The subject is the offending path segment, not the file.** A separator in a directory name
  disqualifies every file beneath it, and none of those filenames is at fault — `src/v#1/util.ts`
  is fixed by renaming `v#1`, and a line blaming `util.ts` sends the reader to rename the wrong
  thing. When the basename is the offender the two coincide.

  **`toDocumentPath` beside `toPosixRelative`.** The path rule and the id rule are now separate
  entry points, because the two answers call for different responses. A path that is not
  workspace-relative at all is a caller handing over something from outside what the Document
  describes, and there is nothing to record — still fatal. A path that merely cannot host an id is
  one file to skip, and the skip entry names it using exactly the rule that will accept it.
  `symbolIdSeparatorSite` answers the second question without an exception and names the segment
  that holds the separator, and the id grammar enforces the rule through the same helper so the two
  cannot drift. `toPosixRelative` now has no caller inside this workspace — the walk records rather
  than refuses, and `makeSymbolId` runs the rule where the id is minted — but it stays as public
  API for a caller that wants the refusal up front.

  **`aburi explain` stops claiming a `#` argument that is not an id.** `cli-spec.md` §7.2 has always
  said the id arm applies to a string that "matches the `<language>:<path>#<qname>` form"; the
  implementation took any `#` and answered "no such Symbol id" for it. That was invisible while no
  `#`-named file could be in a document — and it would have made the file arm unreachable for
  exactly the files this change adds. The id arm now claims the argument only when it is one, and
  §7.2's file arm loses its "contains no `#`" clause, which the same change falsifies.

- 54881d5: Withdraw a file its language plugin refused to parse

  `ParseError.recoverable` has been documented since the plugin types were written:

  ```ts
  /** false → core skips this file. */
  recoverable: boolean;
  ```

  `lang-plugin.md` §7.1 said the same, in more detail: _"the file is skipped, excluded from
  stats.parsedFiles, warning log"_. No non-test code in `packages/**` read the field — every
  occurrence was a write. What actually withdrew a file was `ParseResult.tree === null`, a
  separate signal a plugin sets independently.

  So a plugin following the documented contract — return the tree you managed to build, mark
  the error `recoverable: false` to say "do not use this file" — got its file extracted
  normally. No error, no warning; the instruction was ignored.

  `@aburi/lang-typescript` never noticed. The only `recoverable: false` it emits is paired
  with a null tree, so the real gate fired anyway, and a plugin reasoning from the type
  doc rather than from that coincidence got different behaviour from the one it asked for.

  ## What happens instead

  The two signals are read as one condition. A file is withdrawn when its parse returned no
  tree **or** reported any error marked non-recoverable:

  - no Symbols reach the IR, and `extractSymbols` / `walkBody` / `normalizeAst` are never
    called for it;
  - `ScanResult.skipped` gains an entry with `reason: "parse-failed"`, whose `detail` quotes
    the refusing error's message and position. With no tree and no such error it quotes the
    first recoverable one instead, because a withdrawn file is excluded from the CLI's
    recoverable-error count and this line is then the only place its errors can be read;
  - `stats.parsedFiles` excludes it while `stats.totalFiles` still counts it;
  - the core logs a warning.

  Its **parse errors are still reported** on `ScanResult.parseErrors`, for the reason a
  timed-out file keeps its own: they are diagnostic rather than IR, and here they are the
  entire account of why the file went. Its **import edges are kept** — a file whose contents
  could not be used still told us truthfully what it imports, the one place this differs from
  a file abandoned on its `parseTimeoutMs` budget, which is being withdrawn deliberately.

  Reading the flag also gives a plugin something it did not have: a way to reject a file it
  _could_ parse — a wrong-dialect source, a generated blob — without fabricating a null tree
  to be heard.

  ## The two other halves of that sentence

  The doc promised three things and the code delivered one, _including for the null-tree case
  it did implement_: a file with no tree was excluded from `parsedFiles` and otherwise
  invisible — no `skipped` entry, no warning. Both now happen for both conditions, so
  `ScanResult.skipped` finally answers "why is this file missing from the IR" exhaustively.

  That makes the count derivable from the list, so the counter beside it is gone. On the public
  surface the identity is now `stats.parsedFiles = stats.totalFiles - ScanResult.skipped.length`:
  one subtraction, where before a withdrawn file was both listed and counted and would have been
  netted out twice, reporting two files lost for one.

  What the length has to mean is _at most one entry per file_, which rests on every branch that
  records a skip ending the file's turn in the loop.

  `SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch`
  over it. `ScanReport.skipped[].reason` is narrowed from `string` to that union, so the CLI
  report now fails to compile if a member is renamed rather than silently reporting zero.

  `ParseError.recoverable` is read as exactly `false`, not as a falsy value. Plugins arrive as
  plain JavaScript through a `PluginRef`, and a plugin that simply omits the key would otherwise
  have every file it reported any parse error on withdrawn, silently and at exit `0`. Read
  literally, such a plugin is left where it was before the field was read at all.

  ## The CLI stopped calling a refusal recoverable

  `⚠ N file(s) had recoverable parse errors.` counted every file on `ScanResult.parseErrors`,
  which now includes files withdrawn _for an error that said it was not recoverable_. The
  counts are split:

  ```
  ⚠ 3 file(s) had recoverable parse errors.
  ⚠ 1 file(s) could not be parsed and were left out of the IR.
  ```

  `ScanReport.parseErrorCount` counts files whose errors the plugin called recoverable; the new
  `ScanReport.parseFailureCount` counts the ones it refused. The split is by what the plugin
  said rather than by what reached the IR — a file abandoned on its `parseTimeoutMs` budget is
  counted on the first line and is not in the document, because its errors really are all
  recoverable and they are the reason that path keeps them.

  `aburi scan` stays at exit `0`. An unparseable file is a property of the source, like an
  over-size or timed-out one; `extraction-failed` remains the only reason that gates
  (cli-spec.md §5.4). The same row promised exit `1` on a "cascade of unrecoverable parse
  errors", which nothing implemented and which this change contradicts outright; it now
  describes the read failures that really do end the run.

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

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

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

## 0.1.0

### Minor Changes

- 19f2494: Introduce the `@aburi/types` package. Auto-generates TypeScript declarations from the four public JSON Schemas (`aburi.ir.v1`, `aburi.config.v1`, `aburi.diff.v1`, `aburi.plugin.v1`) via `json-schema-to-typescript`, and adds hand-written contracts for `LanguagePlugin`, `EffectPlugin`, `FrameworkPlugin`, `VocabRegistry`, and the supporting `SymbolCandidate` / `CallCandidate` / `ParseResult` / `*Context` graph. Build artifact is `.d.mts` with an empty runtime stub. Regenerate with `pnpm --filter @aburi/types codegen`.
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

- a8882f0: Introduce the `@aburi/plugin-registry` package. Validates plugin manifests via ajv against `aburi.plugin.v1.json`, then registers their owned extKind / effect id / framework / derivedBy namespaces while enforcing reserved-namespace exclusivity (`core` / `aburi` / `_` / `framework:hint`), xPrefix derivation and consistency, type-namespace ownership, prefix-id shadowing, and prefix-prefix overlap in both directions. Surfaces `VocabRegistry`, `RegistryError`, `loadPluginManifest`, `parsePluginManifest`, and the `RESERVED_NAMESPACES` / `TYPE_NAMESPACE_RULES` constants.

  `@aburi/types` patch: `EffectVocab.description` and `ExtKindVocab.{baseKind, description}` are now nullable to model registry resolution through prefix ownership (`findEffect` / `findExtKind` return non-null for prefix-owned ids that the plugin did not enumerate individually).

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
