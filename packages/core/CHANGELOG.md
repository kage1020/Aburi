# @aburi/core

## 0.4.0

### Minor Changes

- 81dadb6: One outcome per file, and one place a budget comes from

  `FilePipelineResult` spread a file's fate across `terminalParseFailure: boolean` and
  `parseTimeout: ParseTimeoutEvent | null`. Four combinations typechecked, three were reachable,
  and the fourth was forbidden by a rule that lived in a comment: the caller records one skip
  entry per file, so a result carrying both would have been labelled by whichever it tested
  first — a plugin's outright refusal reported as a file that was merely slow, sending the
  reader to raise a budget that was never the problem.

  It is a union of three now: `ExtractedFile`, `ParseFailedFile` and `ParseTimeoutFile`,
  discriminated on `kind`. The variants carry what they actually have, which the widened product could only
  describe as "empty here, present there": a withdrawn file has its `imports` and no `symbols` key
  at all, an abandoned one has neither and carries its `ParseTimeoutEvent` non-null.

  The type names are their discriminants, and the discriminant strings are
  `SkippedFile["reason"]`'s two withdrawal values, so `scan.ts`
  assigns `reason: result.kind` rather than restating them. Its two order-dependent `if`s become a
  `switch` whose `default` is a compile-time `never` — the exclusivity that was a paragraph of
  prose is what the type says now, and a fate added later is a type error rather than a file that
  reaches neither the IR nor the skip list.

  `FilePipelineInput.parseTimeoutMs` and `classifyTimeoutMs` are gone. They duplicated fields the
  `config` on the same input already carried and existed only so a test could pass a budget without
  building a `Config`, which meant the tested path and the production path were not the same path.
  Both budgets are read from `config` now, the two conditional spreads in `scan.ts` that maintained
  the duplication are gone, and the tests pass their budgets the way the CLI does.

  `CoreErrorCode` gains `scan-outcome-unhandled` for the switch's compile-time guard to raise if it
  is ever reached anyway.

- a358a5a: Name the field a diffed IR is missing, instead of crashing on it

  `buildDiff` is public API and ran no integrity check, so an IR a caller assembled in memory
  reached the matcher unverified. Every field the diff dereferences crashed it with a bare
  `TypeError` naming neither the record nor the field — measured, one field deleted at a time
  from a well-formed pair:

  | deleted                                                | crashed in                                                            |
  | ------------------------------------------------------ | --------------------------------------------------------------------- |
  | `symbols[].fingerprint`, `.source`                     | `classifyStatus`                                                      |
  | `symbols[].calls`, `.decorators`, `.effects`, `.rules` | `computeSymbolDelta`                                                  |
  | `components[].roots`                                   | `diffComponents`                                                      |
  | `stats`                                                | `dependencySideView`, which reads `stats.skippedFiles` off every side |

  That list is the shape of the class rather than the whole of it: it is one matcher change
  away from being out of date, which is the argument for a gate that is not scoped to it.

  `buildDiff` now runs `checkDocumentShape` on each side before the identity pass. The refusal
  is a `DiffError` with code `ir-shape-invalid`, naming the side, the record and the field:
  `headIR.symbols[3]: "fingerprint" is absent, not an object.` A breach at the top level has no
  index to name and says so — `headIR: "stats" is absent, not an object.`

  **Invariant #20, and only #20.** The semantic invariants are statements about a Document whose
  answer the diff does not depend on — an unsorted `symbols[]` diffs correctly, because stage 1
  keys by id — so running them would withhold an answer the matcher can give, and `aburi diff`
  would re-pay the full checker on a Document `readIR` already checked. It re-pays the structural
  walk instead: 1.8ms per side at 1,000 Symbols, 17ms at 10,000.

  **This refuses IRs that used to produce an answer.** A Symbol missing `visibility`, `name` or
  `kind` was diffed happily, because nothing in the matcher dereferenced it; so was a Document
  with no `generator` or `workspace`. The gate is scoped to what the `IR` brand asserts rather
  than to what today's matcher touches: a scope that moved with the matcher would leave a
  caller's Document conditionally valid, and `integrity-shape.ts` makes that argument for itself
  while naming this consumer.

  `DiffErrorDetail` gains `violations?: readonly IntegrityViolation[]`, matching
  `CoreErrorDetail`. The message quotes the first breach and counts the rest, which is enough to
  start on and not enough to finish; the array carries all of them, each subject prefixed with
  the side it came from. Additive — no existing field changed.

  `checkDocumentShape` and `DOCUMENT_SUBJECT` are now exported from `@aburi/core`. The first was
  module-exported only, reachable solely through `checkIRIntegrity`, which runs it and then the
  semantic checks this deliberately avoids. The second is what tells a root-level breach from a
  nested one, and a hand-copied literal on the diff side would go quietly wrong if core renamed
  it.

  The messages are the ones `checkDocumentShape` writes, subject naming the record and message
  naming the field, rather than a second wording for the same breach — including the empty
  `$schema`, which is `buildDiff`'s own requirement and now reads in the same shape. Callers
  matching on `DiffError.message` for a malformed Document see the new form; `code` is unchanged.

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

- ff059d7: Say which manifest declared packages and found none

  A `packages:` list whose patterns matched no manifest reaches the same single-project fallback
  as a manifest that declared no packages at all, and only the second wants it. The first is a
  workspace whose every declared package is missing from the Document — from a mistyped pattern,
  from a monorepo with no packages in it yet, or from packages whose manifest Aburi does not
  recognize — and nothing said so.

  The IR keeps no trace a reader can act on. `workspace.managers[].roots` comes back empty, which
  is also what a `turbo.json` co-marker writes on purpose, so the two cannot be told apart from
  the artifact.

  `DetectManagersResult` now carries `unresolved`: one entry per **manifest** that declared package
  patterns and resolved none, with its workspace-relative path and every string it listed. Per
  manifest rather than per manager, because `pnpm-lock.yaml` beside a `package.json#workspaces`
  makes both of a repository's manifests spell `pnpm` — the path is what a reader opens and what
  orders two entries. `aburi scan` and `aburi init` name the manifest and the patterns on stderr,
  and add a second line when nothing resolved anywhere and the whole repository was therefore
  described as one component — not when `components[]` in the config decided them, since
  detection's answer never reached the IR then.

  A `packages:` key that is absent or holds an empty list is not a failed declaration: pnpm reads
  both as "only the root package is included in the workspace", and so does this. Neither is
  turbo, which declares no patterns, nor nx, which has no pattern list at all.

  A `packages:` or `workspaces` that is present and is **not a list of strings** is now refused
  with `workspace-manifest-malformed` naming the manifest and the offending entry, rather than
  filtered away. A trailing colon on an entry — `- tools/*:`, which YAML reads as a map — is the
  most ordinary slip there is, and it silently put every package the manifest declared on the
  single-project fallback. pnpm refuses that shape, a bare scalar and a non-string element alike.

  `ScanReport` gains `unresolvedDeclarations` and `fellBackToSingleComponent`; `InitReport` gains
  the same two. Both are required, so external code assembling either needs the new fields —
  `coverageFault` and `unrepresentableFiles` set the precedent for the minor bump.

- 6676ca7: Read a quoted class member name as the name it spells, instead of losing the file

  `class C { "ok"() {} }` and `class C { 1() {} }` are legal TypeScript — the member is addressed
  as `C["ok"]` / `C[1]` — and both cost the file every Symbol it had. The plugin handed the name
  node's _source text_ to the Symbol-id builder, which refuses anything that is not an identifier;
  the throw was caught at the per-file boundary, and the file was named in `stats.skippedFiles`
  with `reason: "extraction-failed"`. Widening the qualified-name grammar to ECMAScript's
  IdentifierName closed this for a Japanese or accented declaration; a quoted or numeric property
  name is a `PropertyName` and was outside that widening by construction.

  A written name and a qualified-name segment are two different things now. One function answers
  what segment a member's name maps to, or `null` when the grammar has none for it — which is the
  answer `ir-schema.md` §3.2 already gives a computed name: **no Symbol, no diagnostic**, and the
  body stays on the class, where its calls and rules are still reported.

  **A quoted name that decodes to an identifier is that identifier.** A property key is a string,
  so `"ok"() {}` and `ok() {}` declare the same property — `tsc` calls the pair TS2393, a
  duplicate _implementation_ — and they fold onto one Symbol the way a field and a method of
  the same name already do. The literal is decoded rather than unquoted, so an escaped spelling
  names the member it spells.

  **A name the parser guessed at is refused**, and it arrives in two shapes. A literal that parsed
  in part keeps its node and is read as incomplete. One that did not parse at all leaves no
  literal behind: recovery re-emits the surviving characters as a plain name, so `"\uZZZZ"() {}`
  used to record a member called `ZZZZ` — a name the source does not spell. Both now have no
  Symbol, which makes the second the one case where this removes a Symbol the previous release
  produced. What says the name is a guess is an ERROR among the member's own children, so a
  member whose _body_ fails to parse keeps its Symbol as before.

  Two things follow from having one answer rather than two:

  - **`"constructor"() {}` is the constructor.** A class element whose property name is
    `constructor` is the constructor whatever the spelling. Read as a method it took the instance
    qualified name, where it collided with a real constructor's. Two spellings that carry the
    segment stay off the construction path, because neither is a property name: a `static` member,
    and a `#`-private one, whose `#` is exactly what the segment drops.
  - **A field holding a function is gated the same way a method is.** The field gate refused every
    name not written as an identifier, because a name the id builder refuses was a lost file. That
    reason is gone, so `"ok" = () => {}` is now the member `ok` — a Symbol where there was none.

  One diagnostic is corrected on the way past. A module specifier written as a line continuation
  followed by an escape the grammar refuses — `import x from "\<newline>\uZZZZ"` — was reported as
  naming no module, on top of the syntax errors that already said why the name could not be read.
  The continuation contributes no character, so the read came back empty and was indistinguishable
  from an empty literal; reading whether the literal was _wholly_ read tells them apart.

  `@aburi/core` exports `isQnameSegment`, the single-segment predicate a producer needs to ask
  _before_ it builds. `isQualifiedName` is the wrong one for that question and fails quietly: it
  answers about a finished name, so it admits `.` and `::`, and a caller vetting one member name
  with it would accept `"a.b"` and mint the nested qualified name `C.a.b` out of a single member.

- e7f1d49: A receiver hint is spent on the call it was produced for

  `makeReceiverHintKey` keyed an LSP receiver hint by file and line, while
  `makeCallSiteKey` — the key for the other side channel of the same call sites —
  deliberately carries the target too, because "line alone collides in
  `a().b(c().d())`". For a hint channel that collision is not a near-miss.

  **A hint applied to a line applied to every call on it.** `this.charge()` beside
  `sendPaymentToBank()` resolved the second call to `Svc.charge`: an edge no source
  line justifies, a `Dependency` the reader cannot find in the file, and one fewer
  entry in the `unresolved` diagnostics that would have shown the mistake. The
  fabricated edge reached `propagateEffects` like any other, so the effects
  attributed to the caller were wrong in the same direction — an external function
  contributing whatever the class method touches.

  **And when both calls on the line were `this.*`, the hint that survived was
  whichever hover answered last.** `this.foo(this.baz())` resolved `this.foo` to
  `C.baz` against a fast server and to `C.foo` against a slow one — the same input,
  the same server configuration, different `calls[].resolved` and different
  `dependencies[]`. The module docstring claimed LSP arrival order never affects
  output; the jobs it credited for that were not sorted, and sorting alone would
  not have helped while the last write won.

  Hints are now filed and read under `makeCallSiteKey(file, line, target)` — one
  key function for both channels, so they cannot drift apart again — and
  `resolveViaLspHint` additionally checks the hint's `kind` against the receiver
  its call names. The `kind` derivation moved next to the key as `receiverHead`
  for the same reason the key did: both halves of the handshake are computed in
  one place, and a hint that disagrees on either is discarded without a word.

  **A third source of the same fabricated edge is closed by not asking.** The pass
  locates a callee by searching the source line for `<receiver>.<method>`, which
  for `this.emitter.emit` is `this.emit` and matches inside `this.emitter`. The
  server answers about the property, the pass still believes it asked about the
  method, and the hint that comes back is well-formed, correctly keyed,
  `kind`-consistent — and names a callee the call site never reaches. No check on
  a hint can see that, because the hint's target is right and only its position
  was wrong. `this.*` targets of more than two segments therefore issue no hover
  at all; such a call keeps the `null` and the `dynamic` diagnostic it has with LSP
  off, which is the honest answer until the locator can address a whole receiver
  chain.

  Every response for a file is held until all of its jobs have stopped and applied
  in job order (Symbol id, then call line, then target), so what a file produces is
  decided by the sort and not by the server's pace, and the first hint for a call
  site wins. Each apply carries its own `catch`: a throw from inside a `finally`
  replaces the exception unwinding through it, which would erase the server-side
  failure that caused the unwind. A file's responses are still applied on the way
  out of a thrown job, so a per-language fallback keeps what it had already earned.

  `makeReceiverHintKey` and the `ReceiverHintKey` type are gone from the public API;
  `makeCallSiteKey`, now exported from its own module alongside `receiverHead`,
  replaces both. A caller building `receiverHints` by hand must key with it — and
  because both spellings are `string`, a map keyed the old way would compile,
  type-check, miss every lookup, and lose the LSP tier with nothing to show for it.
  `resolveCallGraph` now raises `receiver-hint-key-malformed` on a non-empty map
  keyed any other way rather than handing back a graph quietly missing its typed
  tier.

- 3e180e8: Every Symbol says which Component it belongs to

  `Symbol.component` was `null` on every Symbol the scan produced, and the views that count by it
  said so. A workspace of nineteen Symbols reported `0` against each of its components in
  `workspace.md`, the effect-surface table's `components` column was `—` on every row, and
  `out/components/api.md` was four header lines with nothing beneath them — reviewing a change at
  the level of module boundaries did not work, which is the point of the per-component views.

  The scan attributes each file to the Component whose `roots[]` entry is the longest whole-segment
  prefix of it, and `null` stays the answer for a file under no root at all. Longest rather than
  first, because nesting is ordinary: a workspace root that is a package of its own has
  `roots: ["."]` containing every other component's root, so "the first root that matches" would
  give the whole monorepo to it. Roots are matched by path segment, so `packages/api` does not
  claim `packages/api-legacy/`, and two Components declaring one root are separated by the lower
  `Component.id` rather than by the order the config listed them in.

  The question is asked once per file rather than once per Symbol, which is also what puts the
  answer in front of the plugins: an effect classifier reads it as `owner.component`, and the call
  resolver's component-scope tier keys on it. That tier used to see every Symbol in one "no
  component" bucket, so call resolution moves in both directions on a multi-package workspace:

  - A qualified name declared in **two packages at once** now resolves, inside the caller's own
    component. The two candidates used to make both the component tier and the workspace tier
    ambiguous, so the call resolved to nothing at all — visible in `symbols[].calls[].resolved`,
    in `dependencies[]`, and in the `ambiguous` bucket of `stats.callResolution`.
  - A qualified call **crossing a package boundary** now falls through the component tier to the
    workspace one, so its edge carries `low` confidence where it carried `medium`. The callee is
    the same and the tier is internal — `CallEdge.confidence` is not serialized — but it is the
    weaker claim, and the honest one: nothing about two packages says they are one scope.

  Dropped Symbols are attributed like kept ones — a drop describes a Symbol's shape, not where it
  lives. A Symbol whose component changed with no edit to its code stays `unchanged`, since status
  is decided by the fingerprints and the path: re-rooting a package in the config must not report
  every Symbol under it as a change somebody made.

  `FilePipelineInput` gains a required `component: ComponentId | null`, and
  `buildComponentAttribution` is exported for callers driving the pipeline themselves. Required
  rather than optional because "outside every Component" and "this caller never said" are different
  facts, and an optional key would spell them the same way — attributing a whole scan to nothing on
  a caller that simply forgot it.

- a4d3cff: Keep a file that names things legally

  Three shapes fed something that is not a name into the Symbol-id builder, which threw — and
  the throw cost the file every Symbol it had, not the one declaration:

  | source                                             | before       | now             |
  | -------------------------------------------------- | ------------ | --------------- |
  | `export const { GET, POST } = handlers`            | file skipped | `#GET`, `#POST` |
  | `export const [a, b] = pair`                       | file skipped | `#a`, `#b`      |
  | `export function ユーザー取得() {}`                | file skipped | `#ユーザー取得` |
  | `export function café() {}`                        | file skipped | `#café`         |
  | `export class A { [Symbol.iterator]() {} m() {} }` | file skipped | `#A`, `#A.m`    |

  The last row states it sharpest: one member nobody can name cost the class and every sibling.

  **The qualified-name grammar is ECMAScript's IdentifierName.** `[A-Za-z_$][A-Za-z0-9_$]*`
  becomes `[$_\p{ID_Start}][$\p{ID_Continue}]*`. Only `$` and `_` are named:
  `$` is in neither property, `_` is in `ID_Continue` and not `ID_Start`, and ZWNJ and ZWJ —
  which ECMAScript names separately — are already inside `ID_Continue` here, measured. `schema/aburi.ir.v1.json#/$defs/SymbolId` already accepted every
  one of these, so this closes a gap between the two rather than opening one. What it still
  refuses is what is not a name — a pattern's text, a computed member's brackets.

  **A destructuring declaration produces one Symbol per binding.** `{ a: b }` binds `b`, not the
  key `a`; `{ a = fallback }` and `[a = fallback]` bind `a` and read `fallback`, which is a name
  from another file and not a declaration here. Each binding is a `const` carrying
  `destructured-binding` in `derivedBy` — declared in the plugin manifest alongside the other
  language-level rationales — and that token is what explains several Symbols sharing one source
  range.

  A node type the pattern walk does not model is **refused** rather than passed over. Binding
  nothing for an unmodelled wrapper is indistinguishable from a pattern that declares nothing,
  and a binding lost that way leaves no Symbol, no diagnostic and no `skipped` entry — which is
  worse than the throw this change replaces, because that one was at least named.

  **A class member with a computed name produces no Symbol, and no diagnostic.** Mangling the
  brackets into a segment would invent a name the source does not contain, and two different
  computed keys can collapse onto one segment. A computed name is not a name static analysis can
  record — the position `lang-plugin.md` LP26e takes on a computed module specifier.

  **One integrity consequence.** `symbols[].name` was excluded from invariant #19 (Unicode NFC)
  because the qualified-name grammar was ASCII and NFC leaves ASCII alone. Measured, that no
  longer holds — `isQualifiedName("cafe" + U+0301)` is `true` now — so the field moves onto #19's
  list, which is what the exclusion said should happen if the grammar widened. `symbols[].id`
  stays excluded on a reason that does still hold: `symbolIdViolation` checks NFC in its own
  right rather than as a side effect of an ASCII grammar.

  No existing Symbol id changes: measured by scanning the `nestjs-billing` fixture before and
  after and diffing the id sets — 38 ids, identical.

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

- 6d4730f: Keep a throw inside LSP enrichment from ending the scan and stranding the server

  `enrichWithLsp` called `processLanguage` with nothing around it, so anything thrown between
  starting a language's server and shutting it down left that server running — a real
  `typescript-language-server` child process with neither `shutdown` nor the SIGKILL behind it
  ever reached. The same throw travelled out of the pass and ended the whole scan, over an
  enrichment that is optional by design and whose every value has an untyped-tier one already
  written underneath it.

  `didOpen`, `didClose` and each request were individually guarded; the code that _applies_ their
  results was not. `applyDocumentSymbols` recursed over the server's `DocumentSymbol` tree without
  a bound, and a tree deeper than the JavaScript call stack — a depth the server chooses — arrived
  as `RangeError: Maximum call stack size exceeded` thrown out of the pass.

  Both halves are closed. The language body now runs in a `try`/`catch`/`finally` that opens once
  the server exists and before it is asked for anything: a throw is the per-language tier of §6.1
  — warn once, disable the language, keep going — and the `finally` shuts the server down on every
  exit, including the two that previously each had their own call. Whatever the language enriched
  before the throw is kept, per §6.2. A `shutdown` that itself fails is now warned about rather
  than silently swallowed; it means a server that may still be running, which is the whole thing
  that call prevents.

  `applyDocumentSymbols` walks an explicit stack instead of recursing, so the depth is the
  server's to choose again. Children are pushed in reverse so the visit order is unchanged —
  pre-order, parent before children, siblings in source order — because matching takes the first
  entry at a given line and name, and the order decides which columns a Symbol gets. The shape is
  the server's to choose too: a `children` that is `null` rather than absent reads as no children,
  the way the recursion's `?? []` did.

  `runJobsWithConcurrency` no longer settles on the first rejection. `Promise.all` cancelled
  nothing, so the surviving workers went on calling a client that had been shut down and writing
  into Symbols the pass had already returned — which is the determinism guarantee in §10.6, not
  untidiness. Workers now record their failures instead of rejecting, every worker is awaited, and
  the lowest-indexed failure is rethrown. Running the remaining jobs rather than abandoning them
  keeps the set of writes a failing file produces the same on a rerun.

  `safeShutdown` is bounded. It was the only client call in the pass without a deadline, awaited
  from a `finally`, so an injected client whose `shutdown` never settled stopped the scan with
  nothing to read. A hang now reports the same "it may still be running" line a failure does.

  `lsp-enrichment.md` §6.2 gains the rule the retention rests on — columns already written when a
  fallback fires are kept, which is not what "remain `null`" says — and §6.1 cites it. §6.3 names
  the third per-language condition's rules: the pass must not propagate an exception, a started
  server must be shut down exactly once on every exit, a shutdown warning is not counted by rule
  3, and the pass must not write to the Document after it has returned.

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

- e2dab93: Establish the Document's shape before the invariants assume it

  `checkIRIntegrity` took an `IR` and dereferenced its way through the Document. `readIR`
  brands a parsed JSON object after checking `$schema`, so in practice the checker is the only
  gate a Document read off disk passes — and it assumed the thing it was being asked to
  establish. Fourteen shapes that survive that gate produced a `TypeError` instead of a
  violation list, among them a missing `workspace`, a `stats.callResolution` of `null`, a
  non-string entry in `components[].roots`, and a `derivedFrom` of `null`.

  The CLI wrapped each as `config-error`, so a user was told the IR failed to load and not
  which invariant broke — which is the one thing the invariant list exists to say.

  **Invariant #20** is the Document's shape as `aburi.ir.v1` requires it: every `required`
  field, of the declared kind, at every depth. It names the record and the field:

  ```
  [#20] symbols[0]: "fingerprint" is absent, not an object
  [#20] document: "workspace" is absent, not an object
  [#20] components[0].roots[0]: entry is a number, not a string
  ```

  Three decisions worth stating:

  - **The scope is the schema's requirements, not "the fields the invariants read".** `readIR`
    brands its result `IR` on the strength of this check, so what #20 establishes is what that
    brand asserts. A narrower check would hand `@aburi/diff` a Document with no `fingerprint`
    and let it fail on `b.fingerprint.logic`, outside anyone's error handling and with no file
    or field named.
  - **The restatement is checked, not trusted.** A test reads `schema/aburi.ir.v1.json` and
    fails on a `required` entry with no counterpart in the spec, on a spec field the schema
    does not declare, and on a structural definition the spec omits entirely.
  - **#20 is reported alone.** The nineteen relational invariants are statements about a
    Document; a value that fails #20 is not one.

  `checkIRIntegrity` and `assertIRIntegrity` now take `unknown`. Every other caller holds a
  typed `IR` and is unaffected; the caller these exist for holds a parsed JSON object, and
  declaring `IR` had them assert what they were being asked to establish. `readIR` brands
  after the check rather than before, and its own array pre-check is gone — #20 covers it, and
  a duplicate is only a second place for the answer to drift.

  Also fixed by the same shape guarantee: four invariants that a mistyped field silently
  disabled rather than crashed. `dropped: "true"` skipped #5 entirely, `derivedFrom: 5` passed
  #11 because `(5).length` is `undefined`, and `workspace.languages: [null]` passed #18 because
  the grammar regex coerced `null` to the string `"null"`.

- 309f093: Withdraw the file a plugin threw on, instead of the whole run

  `lang-plugin.md` §7.2 has always said what should happen when extraction throws:

  > - If `extractSymbols` / `walkBody` / `normalizeAst` throws → skip the entire file, warning log
  > - The extraction pipeline as a whole does not stop (prevents one file's bug from halting all IR generation)

  Neither `scan.ts` nor `pipeline.ts` contained a single `try`, so it never did. One throw
  discarded every file's results and the run produced no IR at all:

  ```ts
  // src/route.ts — an Auth.js route file, and legal TypeScript
  export const { GET, POST } = handlers;
  ```

  The destructuring pattern's text reaches `makeSymbolId` as a qualified name, the id grammar
  refuses it, and `scan()` exits non-zero having written nothing. A `src/ok.ts` beside it produces
  nothing either; delete the one file and the same run succeeds.

  ## What happens instead

  Any plugin call that throws for a file — `parseFile`, `extractSymbols`, `walkBody`,
  `normalizeAst`, a framework `classifySymbol`, an effect `classify` — withdraws that file. The
  run continues, and the file is accounted for twice:

  - `ScanResult.skipped` gains `reason: "extraction-failed"`, so it is named in the list that
    answers "why is this file missing from the IR";
  - `ScanResult.extractionFailures` is a new `{ file, message, code? }[]` carrying what the plugin
    actually said, the way `parseTimeouts` carries numbers `skipped` has nowhere to put. The CLI
    lists the first ten on stderr with the file and the message, capped so a plugin that rejects
    every file cannot scroll the rest of a CI log away.

  A file that is _gone_ by the time the scan reads it — discovery lists the workspace up front, and
  a concurrent build can delete a listed path before the loop reaches it — is skipped as
  `"unreadable"`, the reason discovery already uses for the same condition, rather than ending the
  run as it did before. **Every other read failure still ends the run**: a permission the checkout
  got wrong, an exhausted descriptor table, failing storage. Those depend on how the machine was
  feeling, and absorbing them would let one commit produce a different Document on a different day
  and still exit 0, which is the opposite of what a byte-stable canonical document is for.

  Unlike a file abandoned for its `parseTimeoutMs` budget, a thrown file loses its recoverable
  parse errors: the pipeline result never materialized. The thrown message stands in for them.

  ## Some throws are still fatal

  An error whose code names a fault in the plugin _set_ rather than in the file propagates and ends
  the run:

  - `scan-plugin-misconfigured` — an effect plugin returning a Promise from the synchronous
    `classify`, a language plugin emitting Symbol ids with no language prefix at all;
  - `invalid-language-id` — the prefix is present but is not a legal `LanguageId`, which comes from
    the plugin's own `languageId` and so is the same on every Symbol it emits;
  - `vocab-undeclared` — an effect or extKind id the emitting plugin's manifest does not claim.

  Each repeats for every file, so absorbing them would report the workspace as broken instead of
  the plugin, and would replace one precise sentence about the manifest with a file count.

  Everything else describes the file and is absorbed: `anonymous-symbol-id-attempted` and
  `invalid-symbol-id` come from what a declaration is named, `non-posix-path` from where it lives.
  The check reads the error's `code` rather than its class, because `vocab-undeclared` is a
  `RegistryError` and `@aburi/core` does not depend on `@aburi/plugin-registry`.

  A plugin-wide bug carrying none of those codes now presents as one failure per file rather than
  one crash. That is the intended shape rather than a regression — every file named, the messages
  identical, the count the whole workspace — though it is a weaker diagnostic than a code that says
  outright what is wrong.

  `ScanResult.extractionFailures[].code` carries the thrown error's own code where it had one, so a
  consumer can separate "this source is something the plugins cannot express" from "a plugin
  crashed" without matching on prose.

  ## `aburi scan` exits 3 when a file was dropped this way

  Without this the change would be a loudness regression: a guard firing would go from "exit 1, no
  output" to "exit 0, output written, a line on stderr". `cli-spec.md` §5.4 already assigns `3` to
  a plugin error for `scan`, and a reviewer now gets both the partial IR _and_ a non-zero code,
  where a thrown guard previously gave them neither.

  The scope is exactly `extractionFailures`. Over-size, unroutable and timed-out files keep exiting
  `0` — whether they should gate, and behind what threshold, is a separate open question.

  `ScanReport` gains `extractionFailures`, and the stderr block names the count on its own line so
  a reader handed a non-zero status can tell which of the counts earned it.

  ## Contracts restated rather than changed

  `effect-plugin.md` EP3a and the `plugin-input` guards said a contract violation "fails the scan".
  It now fails the _file_. EP3a's reason for refusing to degrade — that a silently unclassified
  call turns a parser bug into a quietly under-populated IR — is untouched by this: a withdrawn
  file is counted, named, quoted back with the guard's own message, and reflected in the exit code.
  Silence was the objection, and there is none here.

  `SkippedFile.reason` widens by one member, which is breaking for an exhaustive `switch` over it.

  ## Two things this makes visible rather than fixes

  A withdrawn file leaves no trace **inside** the IR. `skipped` and `extractionFailures` are
  siblings of `ir`, not part of it, so `out/aburi.ir.json` records only that `parsedFiles` is below
  `totalFiles` — the same gap an over-size file leaves. A `diff` against a healthy baseline
  therefore reports the withdrawn file's Symbols as `removed`, and `--fail-on removed` trips with
  the wrong explanation. Before this change there was no IR to be misled by; now there is a
  complete-looking partial one, and the exit code is the only signal, which does not travel with
  the artifact. The other withdrawal reasons have the same hole and have had it all along.
  Tracked separately.

  `export const { GET, POST } = handlers` — an ordinary Auth.js route file — is a reachable trigger,
  so a repository containing one now exits 3 on every scan where it previously exited 1. The gate is
  reporting a real loss rather than causing one, and the remedy is the id-grammar bug behind it
  rather than this boundary.

- 74aa475: Refuse a `.gitignore` rule by its length rather than by asking a regex engine

  **A `.gitignore` rule between 4,097 and roughly 32,000 characters worked before and now fails
  the scan.** That is a break rather than a fix, which is what this note is for.

  Where a regex engine's code-size limit falls, and what reaching it costs, is the engine's
  business. Measured on Node 24 with `ignore@7.0.6`: V8 accepts a 32,000-character rule in 433 ms
  on Windows and refuses one of 33,000 in 348 ms, while a macOS CI runner spent **forty-three
  seconds** on a 40,000-character rule. A workspace holding such a line could therefore scan on one
  machine and fail on the next — the property the Document exists to avoid — and the scan that did
  fail paid most of a minute for it.

  So a rule longer than 4,096 characters is refused outright, with the file and the line named,
  before any engine sees it. No real pattern reaches that: a gitignore rule is a path glob, and
  4,096 is `PATH_MAX` on Linux — the platform with the most generous limit of the three, so a
  bound that clears it clears macOS's 1,024 and Windows' 260 as well.

  Shorter rules are still compiled when the file is read, so one an engine refuses for another
  reason — `a/[/b` is five characters and unterminated — still cannot escape as a bare
  `SyntaxError` at a later candidate.

- fc8f3c9: Implement `config.parseTimeoutMs`, which the schema had documented and nothing read

  `parseTimeoutMs` appeared only in `aburi.config.v1.json` and the type generated from it.
  Setting it changed nothing, so the one lever a user had against a file that would not finish
  did not exist.

  It is now a per-file budget over parse + extract + walk, per lang-plugin.md §7.1.2, defaulting
  to the schema's 5000 ms and clamped up to its 100 ms minimum. The budget is **cooperative**,
  for the same reason the classify budget is (effect-plugin.md §5.1.1): `extractSymbols` and
  `walkBody` are synchronous plugin calls, and nothing can interrupt one that has started. It is
  read where control is back in the pipeline — after `parseFile`, after `extractSymbols`, and
  before each candidate's walk — so what it guarantees is that an over-budget file is handed no
  further work. A file costs at most its budget plus one stage, and a single enormous candidate
  can still overrun by however long that candidate takes.

  An over-budget file contributes nothing to the IR: no Symbols, no import edges. Keeping
  whichever Symbols it finished first would make the Document depend on how fast the machine was
  that day, so the outcome is binary per file. Its **parse errors are still reported**, because
  they are diagnostic rather than IR and because backtracking over malformed input is a common
  reason for a slow parse — a run that swallowed them would send the reader to raise the budget
  when the fix is the syntax.

  Such a file lands in `ScanResult.skipped` under a new `reason: "parse-timeout"` and again on
  `ScanResult.parseTimeouts` with the budget and the elapsed beside it, is left out of
  `stats.parsedFiles` while still counting toward `stats.totalFiles`, and warns in the shape
  lang-plugin.md §7.1.1 uses for the size cap:

  ```
  Skipped src/generated/client.ts: extraction reached 7413ms, exceeding parseTimeoutMs (5000ms). Override with config.parseTimeoutMs.
  ```

  Skipping on wall clock does mean the IR can differ between a fast machine and a slow one, at
  file granularity. That is inherent in asking for a time budget rather than introduced here; a
  run that needs reproducibility across machines sets the budget high enough that nothing reaches
  it. The tests accordingly never assert that something finished in time — a stub plugin
  deliberately spends the budget, so the over-budget cases can only fail in the direction of a
  machine spending more.

  `@aburi/core` also exports `startParseDeadline`, `ParseDeadline`, `ParseTimeoutEvent`,
  `DEFAULT_PARSE_TIMEOUT_MS` and `PARSE_TIMEOUT_MIN_MS`. `SkippedFile.reason` gains a fourth
  member, so an exhaustive `switch` over it needs a new arm. The CLI's skip summary no longer
  says "skipped during discovery": two of the four reasons are decided after it.

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

- 060d7a5: Read the `.gitignore` in every directory, the way git does

  Discovery read one file — the workspace root's — so `packages/app/.gitignore` holding
  `fixtures/` did nothing and those files were parsed into the IR. That is the ordinary way to
  say a package's fixtures are not source, and the workspace was saying it to nobody.

  Git consults a `.gitignore` in each directory from the repository root down to the file's own,
  and the deepest file with an opinion decides — whichever direction it points. Twenty-eight
  verdicts were measured against `git check-ignore` and are hardcoded as tests.

  **This changes which files are in the IR, in both directions.** A package-local exclusion now
  drops files, so a diff against an IR produced before this reports them as removed; a nested
  `!` line now re-includes files, which appear as added. Neither is a change in the workspace —
  run `aburi scan` on both sides before reading such a diff.

  - A nested file's patterns are relative to its own directory: `/local.ts` in `packages/app`
    anchors to `packages/app/local.ts` and leaves `packages/app/sub/local.ts` alone.
  - Nothing re-includes a file under a directory that was excluded, across files as within one:
    a root `gen/` cannot be undone by `gen/.gitignore` holding `!keep.ts`. A root `gen/*` can,
    because it never excluded the directory.
  - `$GIT_DIR/info/exclude` and `core.excludesFile` are still not read, deliberately: both are
    per-machine, and the Document must not depend on who ran the scan. `.git/.gitignore` is not
    a rule file to git and is not one here.
  - A `.gitignore` that is not a regular file is no patterns rather than a read failure that
    ended the run: a **directory** of that name, and a **symlink**, which git refuses to follow
    whether or not it resolves. Anything else that is not a regular file goes the same way,
    rather than blocking forever on a FIFO as git does.
  - A `.gitignore` that exists as a regular file and cannot be _used_ still ends the run, naming
    the file **and the line** — which is stricter than git's own warn-and-continue and is the
    point: a rule list that silently came up empty puts excluded files in the Document. Every
    rule is compiled when the file is read rather than when a candidate happens to reach it, so
    a pattern the regex engine refuses can no longer escape as a bare `SyntaxError` hundreds of
    files later, naming neither.
  - Rule files are opened by descending to them, as git finds them. One under a directory with
    no surviving candidate — dropped by the Category A globs, excluded by an outer `.gitignore`,
    or inside `.git` — is never opened, so it can neither apply nor fail.

- 74aa475: Decide a component's languages over the files a scan would actually read

  `Component.languages` is decided by counting file extensions in a component's subtree, and the
  census carried its own eight-pattern exclusion list where discovery has twenty-six — and read no
  `.gitignore` at all. A git-ignored tree, a vendored copy, or a previous run's `out/` was counted,
  so a component could be labelled with a language no Symbol in it is written in. That label is in
  the IR and is compared across revisions.

  Detection now takes the same _drop_ decision discovery takes: the shared core pattern list,
  every directory's `.gitignore` under `config.respectGitignore`, and — from the caller that has
  them — `config.ignore` and the loaded language plugins' file-drop globs.

  Not the routing decision. The census still counts every extension it knows, whether or not a
  plugin claims it and whatever `maxFileSizeBytes` says, because `Component.languages` answers
  what a component is written in rather than what a run parsed (`component-detect.md` §4.4) — and
  `aburi init` has to answer it before any plugin exists.

  **A component's `languages` can change without the workspace changing.** A language whose files
  were all excluded disappears from the list; a component left with nothing falls back to `ts`, as
  it already did for an empty directory.

  - `detectComponents` gains `ignore` and `respectGitignore`. `aburi scan` passes both; `aburi
init` passes neither and gets `.gitignore` plus the core patterns, which is everything
    knowable before a config exists.
  - The census is one walk from the workspace root, bucketed by component root, rather than one
    walk per root. `config.ignore` is workspace-root relative by contract and cannot be matched
    against a walk rooted inside a package — `packages/app/fixtures/**` matched nothing there, and
    `fixtures/**` would have matched every package's.
  - `languageFileDropPatterns` is exported from `@aburi/core`; `CORE_IGNORE_PATTERNS` is shared
    between discovery and detection inside the package. Either way the two halves of a scan read
    one list rather than two that had already drifted.
  - `aburi init` reads `.gitignore` now, so one it cannot use fails the command where before it
    could not. `init` gains `--respect-gitignore` / `--no-respect-gitignore`, and the failure
    names the flag — there is no config to turn it off in, since this command writes the first one.
  - A failure while resolving components is no longer always exit 2. Detection walks the
    workspace and opens rule files, so an `EACCES` or an `EIO` from that walk is a runtime failure
    (exit 1); a component id or path the config cannot hold keeps exit 2.

- 1e59445: Decide a file the scan cannot open the same way at both stages that open one

  Two calls in a scan open files: discovery's `stat` on every candidate, and the `readFile` the
  orchestrator does just before extraction. They disagreed about what a failure meant. The
  orchestrator absorbed only `ENOENT` and re-threw the rest, and said why — a permission the
  checkout got wrong or an exhausted descriptor table depends on how the machine was feeling, so
  absorbing it lets one commit produce a different Document on a different day. Discovery
  recorded every errno as a skipped file, so the identical `EACCES` on the identical machine
  either ended the run or quietly shrank the IR, according to which of the two calls happened to
  reach the file first. Nothing gated the second outcome: `minParsedFileRatio` is unset by
  default, so the run exited `0`.

  One predicate now decides both. It holds `ENOENT` and `ENOTDIR`, because the operating systems
  disagree about what to call one event: replacing a directory with a file while a scan runs is
  answered `ENOTDIR` on POSIX and `ENOENT` on Windows, and a predicate holding only `ENOENT` made
  the same act fatal on one platform and benign on the other. Everything else propagates out of
  `discoverFiles` as the operating system raised it, which is what the orchestrator already did,
  and reaches the CLI's exit code `1`.

  So `unreadable` now means one thing wherever it appears — the file stopped being one while the
  scan ran — and `aburi scan`'s advice for it no longer sends the reader to check permissions,
  which after this change cannot have caused it.

  **`describeThrown` no longer answers a thrown empty string with an empty string.** It exists to
  replace a plugin's silence, and `throw ""` produced exactly that, one step further in: the
  value lands on `skipped[].detail` and `extractionFailures[].message`, where nothing separates
  "the plugin said nothing" from "nobody recorded anything". The guarantee is now non-emptiness
  and it is enforced on the result rather than inside the chain, since an object whose `toJSON`
  returns `undefined` and whose `toString` returns `""` reaches the end and comes back empty too.
  Discovery's `stat` detail and the `.gitignore` read failure both go through it, replacing an
  unguarded `(error as Error).message` that left `detail: undefined` for a non-`Error` throw and
  a third copy of the same chain.

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

- c3654c3: Stop answering "No matches" out of an IR that says it never read the file

  `aburi explain` reports the incidents of a scan it runs itself. Reading an IR off disk it runs
  no scan, so there is nothing live to report — but the document it read carries
  `stats.skippedFiles`, and the answer ignored it:

  ```
  $ aburi scan
  ⚠ 1 file(s) could not be parsed and were left out of the IR.
  $ aburi explain handleRequest --ir out/aburi.ir.json
  No matches for "handleRequest".
  EXIT=1
  ```

  `src/route.ts` declares `handleRequest`, the IR says `src/route.ts` was never parsed, and the
  answer asserts the Symbol does not exist. Every fact needed to say otherwise was in the file
  that had just been read. `--ir` and `--no-rescan` exist so a CI job can question a pinned
  artifact without re-scanning, which is exactly the path where nobody is watching a live scan's
  stderr — so it is the path where the document has to speak for itself.

  **One principle decides every case.** The answer is `unknown` (exit 3) when the document
  positively identifies the file the question named as one it never analysed; it stays "not found"
  (exit 1) with a qualifying line when the doubt is diffuse. The id arm reads the `<path>` segment
  of the id, the file arm reads the argument, and the pattern arm names no file at all.

  ```
  $ aburi explain src/route.ts --ir out/aburi.ir.json
  Cannot answer "src/route.ts": this IR never analysed src/route.ts (parse-failed), so it cannot say what that file declares.
  EXIT=3
  ```

  Exit 3 already meant "this answer is not safe" — until now only because the scan this command
  ran did not exit clean. The second route says the same thing about different evidence, and it is
  narrower: the scan is intact, and only the question that named the withdrawn file is
  unanswerable.

  **What follows from the principle**

  - **The file arm no longer requires the path on disk**, only that the document names it in
    `stats.skippedFiles`. Requiring it locally would have dropped the motivating case — a pinned
    artifact read in a tree that need not hold the same files — into the pattern arm.
  - **The check runs on a miss only, so a hit is never qualified.** A hit is the document speaking
    about a Symbol it holds, and an `over-size` file is skipped by every run of a workspace, so
    caveating hits would caveat that workspace's every answer forever. This is also what answers
    an id whose `<path>` segment and `symbols[].source.file` disagree, as a re-export or a
    generated file produces: the Symbol is right there.
  - **The id arm asks the id grammar rather than the `#` it dispatches on.** `symbolIdFile` is new
    in `@aburi/core`, beside the grammar it runs, and returns `null` for anything `makeSymbolId`
    would have refused — so a typo that happens to contain a skipped path names no file and gets
    the diffuse line instead of a positive claim about coverage.
  - **A document predating `stats.skippedFiles` gets the diffuse line in every arm.**
    `totalFiles > parsedFiles` with no list can be counted but never tied to the file that was
    asked about. `aburi diff` warns about the same shape per side.
  - **The file arm's key is normalised into the space the document is in.**
    `stats.skippedFiles[].path` and `symbols[].source.file` are NFC by schema and by invariant
    #19; the argument is whatever the shell handed over, and a name carrying a combining mark
    survives an archive or a rename in decomposed form. Both of the arm's lookups key on that one
    string, so the same fix ends the older defect where a decomposed argument found none of a
    file's Symbols and was told it had no matches.

  The diffuse line is a count and a pointer at `stats.skippedFiles`, not a list. The question was
  about one Symbol; answering it with an inventory of the run buries it.

  **The library surface.** `ExplainOutcome` gains an `unknown` member whose `exitCode` is typed
  to the gate alone, and `not-found` gains a `coverage` field carrying either the lost entries
  themselves or, for a document that cannot name them, a count. Facts rather than prose: the
  wording lives in the CLI wrapper, the only layer that knows it is talking to a person, and the
  non-empty entry list is what keeps the number it prints from drifting from the list it
  describes. The wrapper's switch is exhaustive, so a later member is a type error rather than a
  command that exits on a code with nothing written to explain it.

  **`@aburi/core`.** `symbolIdFile` is new. Invariant #21 gains a clause that does not depend on
  `stats.skippedFiles` being present: `parsedFiles` never exceeds `totalFiles`. For a document
  that omits the list, the subtraction is the only trace of a loss there is — a reader taking a
  negative difference for a count reads it as "nothing was lost", which is the assertion of
  absence the enumeration exists to prevent, arrived at from the other side. A document with that
  shape is now refused by `readIR` instead of interpreted downstream; no Aburi scan can produce
  one.

  Verification: 28 tests in `packages/cli/test/explain-coverage.test.ts`, covering each arm on
  both sides of the principle, plus four in `@aburi/core` for `symbolIdFile`'s accept/reject table
  and the new invariant clause. Two exist for the miss-only rule: a Symbol whose id names a
  skipped file while its `source.file` names another, and a listed path that still carries the
  Symbols it was asked for. One pins that a live scan which withdrew a file benignly, and
  therefore stayed green, still reaches the new exit 3, with a control case proving the scan was
  green.

- 0b39623: Read a component's identity from its package manifest, not from whichever detector arrived first

  A directory two detectors claim is described by two manifests. It now keeps both — plus the
  `package.json` under its root whether or not a detector reported it — and they are read in the
  order `component-detect.md` §4.1 gives, by filename, so the order the detectors ran in cannot
  move a Component's id.

  Before, the first candidate merged kept its manifest and the other was discarded. `nx` sorts
  before `pnpm`, so in an nx workspace using pnpm the `project.json` won every directory that had
  both, and the `package.json` beside it was dropped along with everything only it carries:

  - `id` and `name` came from `project.json#name` — the nx project name — rather than from the
    published npm name the rest of the Document is written against.
  - `frameworks` and `publicApi` were empty, because `dependencies` and `exports` are npm fields
    and an nx project file has neither.

  In an nx workspace with no `pnpm-workspace.yaml` and no `workspaces` key, no detector reported
  those `package.json` files at all, so the same three fields were lost there whatever the merge
  did. `buildComponent` reads the one under each candidate root now, which is also what makes the
  fix independent of an unrelated file elsewhere in the workspace.

  §4.1 and §4.2 name `project.json#name` as a source below `package.json#name`, which is what an
  nx-only directory with no `package.json` has always used in practice: its id and name are
  unchanged. Three things are new for it:

  - `frameworks` and `publicApi` are read from the `package.json` alone, so a `project.json` with
    a `dependencies`- or `exports`-shaped key — an nx target option may be any JSON — no longer
    produces either.
  - A `package.json` beside the `project.json` supplies all five fields, as above.
  - A manifest that is present and cannot be read — bad JSON, or an IO failure that is not "no
    such file" — aborts detection with `workspace-manifest-malformed` naming the file, rather
    than being silently skipped. `aburi scan` reports that code as a config error and exits 2,
    which `detectPnpm`'s existing throw of the same code was not doing either.

  A `name` that is not a string is passed over rather than crashing the run, and a `name` that
  yields no id — `@scope/` — no longer stops §4.1's search at the directory name.

- da20510: Open a file by the name the filesystem gave it, not the one the Document records

  `toDocumentPath` normalizes a path to NFC on the way into the Document (ir-schema.md §1.2), and
  three sites then handed that normalized string back to the operating system: the `stat` in
  discovery, the `readFile` in the scan orchestrator, and the `file://` URI the LSP pass tells a
  language server to open. A filesystem that stores the name it was given — NTFS, ext4 — does not
  answer to the normalized spelling, so a file whose name was not already in NFC was reported
  `unreadable`, with an `ENOENT` naming a path almost but not quite the one on disk.

  `DiscoveredFile` now carries both: `path` for the Document and `fsPath` for whatever opens the
  file. Only `path` reaches a Symbol id, so nothing about the artifact changes for a workspace
  whose names are all ASCII.

  **Two spellings of one name are reported instead of ending the scan.** Both normalize to one
  Document path, so the pipeline read one file twice and minted its Symbol id twice — and
  `assertIRIntegrity` ended the run on `[#1] duplicate Symbol id`, naming neither file. Every
  claimant is now withdrawn and reported on `ScanResult.unrepresentableFiles`, which grew a
  `reason` to say which of the two things happened; `aburi scan` prints a section per cause and
  exits 3. The collision section spells each name out by codepoint, because the two print
  identically in a terminal.

  `EnrichmentInput.fileContents` becomes `ReadonlyMap<string, { content, fsPath }>` for the same
  reason the read changed: a `file://` URI is a filesystem address. One entry rather than a second
  map keyed the same way, so "a file that was read has a spelling on disk" holds by construction
  instead of by agreement. A caller of `enrichWithLsp` outside the core passes `fsPath: path` for
  any name already in NFC, which is every ASCII one.

- baa6857: Resolve a declared package against its manifest, so `packages: ['.']` names the workspace root

  A pnpm or npm workspace pattern names a directory that holds a `package.json`, and is now
  matched as `<pattern>/package.json` — the directory holding each match is the candidate. That
  is what both managers mean by their patterns, measured with `pnpm ls -r`, and it is the rule
  the nx detector already followed with `project.json`.

  Matched as directories instead, two patterns meant something else entirely:

  - `'.'` is a glob that reaches every directory in the workspace. A two-package workspace holding
    `src/` and `a/b/c/d/` produced seven components — six of them named after incidental
    directories — and the workspace root, the one directory `'.'` names, was not among them.
  - A literal path swallowed its own subtree: `'tools/build'` also produced `tools/build/nested`.

  Four further changes fall out of the rule:

  - A matched directory with no manifest is no longer a component, because it is not a package to
    the manager that declared the pattern. Where _no_ matched directory holds one, detection falls
    through to the single-project fallback and the whole repository becomes one component.
  - Only `package.json` is recognized. pnpm also accepts `package.yaml` and `package.json5`; a
    package declared in either was a manifest-less candidate before and is not detected now.
  - `WorkspaceCandidate.manifestPath` is no longer nullable, since a candidate is now found by
    finding its manifest.
  - A `**` pattern reaches ten directory levels rather than eleven, which is the ceiling the glob
    conventions always documented.

  Which of the resolved directories become components is unchanged and is Aburi's own rule: the
  workspace root is a component when a pattern names it, where to pnpm the root is a workspace
  project whether or not one does.

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

- dbdc8aa: Refuse a backslash in a filename instead of rewriting it into a path separator

  `toDocumentPath` and `toPosixRelative` began by rewriting every `\` into `/`, before any
  validation ran. A backslash is a legal POSIX filename character, so a file named
  `weird\name.ts` was silently renamed to `weird/name.ts`: the Symbol ids built beside it named
  a path nothing can open, and `a\b.ts` beside `a/b.ts` collapsed onto one path, which invariant
  #1 reported as duplicate ids rather than as the filenames that produced them. The shared path
  rule has always refused the character and has a message for it; nothing reached the check,
  because the rewrite spent the character first.

  The two entry points now normalize NFC and validate what they are given. Converting a native
  path is the caller's job, because only the caller knows it holds one — `toRelativePosix` in
  `workspace.ts` shows the shape, rewriting on the platform separator, which is a separator
  exactly where a filename cannot hold one.

  **Migration.** A caller passing a native path to either entry point must convert it first:

  ```ts
  import { sep } from "node:path";
  toDocumentPath(sep === "/" ? nativePath : nativePath.split(sep).join("/"));
  ```

  Nothing in this repository needed the change: the file walk takes its paths from `glob`, which
  returns POSIX separators on every platform.

  `aburi scan` reports such a file and exits 3. It cannot be recorded on `stats.skippedFiles`,
  because that path is held to the same rule, nor counted in `stats.totalFiles` without being
  recorded, because integrity #21 pins the skip list's length to `totalFiles - parsedFiles`. So it
  leaves the census the way a file no plugin claims does, and `ScanResult.unrepresentableFiles`
  plus the stderr paragraph built from it are the run's only account of it — which is why the exit
  code moves. `aburi explain` answers for one of these files without consulting the document, since
  no document could hold it.

  `aburi diff` names it as the fault for the side that has it, in ref mode, where it runs the
  scans. `--base` / `--head` reads two documents and neither records the file, so a rename into
  such a name reads as deletions there: `dependencySideView` builds its lost-file set from
  `stats.skippedFiles`, which this file is absent from by construction. That is a limit of the
  frozen path grammar rather than of the diff, and is recorded as a v2 shape in `ir-schema.md`
  §15.4.

- 836b05a: Decide `.gitignore` the way git decides it

  `.gitignore` was translated line by line into globs and handed to the file walk's ignore list.
  A negation cannot do anything there: a directory the walk skipped never produces the file a
  later `!rule` would have put back, so an explicit un-ignore was dropped silently — while the
  function's own docstring said negation was preserved.

  Measured against real `git check-ignore` over 18 pattern sets, the translation agreed on 13,
  and every disagreement lost a file git keeps:

  - `assets/*` with `!assets/keep.ts` — the directory itself was never excluded, so git reaches
    the negation and keeps the file
  - `*.log` with `!keep.log` — the same shape without a directory
  - `src/` followed by `!src/` — a directory put back
  - a file literally named `a[1].ts` — brackets are a character class, so the literal name is not
    what the pattern matches
  - `*` with `!src/` and `!src/a.ts` — everything excluded, then one directory and one file put
    back

  The file is now compiled into a matcher and every discovered candidate is asked about it, and
  the glob translation is gone. Git's two rules pull opposite ways — a later `!rule` re-includes,
  and nothing re-includes under a directory excluded outright, because git never descends into it
  — and both hold now, which is what a pruned walk could not do.

  The cost is that a `.gitignore`d directory is walked rather than skipped. What such a file
  usually names — `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.venv` — is in
  the core drop list and is still pruned there.

  Matching is case-sensitive, against the matcher's own default. Git folds case only where
  `core.ignoreCase` says so — false on ext4, true on NTFS and APFS — so no single setting agrees
  with git everywhere; folding would drop a file git keeps wherever git is case-sensitive, which
  is the direction that loses data and the one the glob translation being replaced already got
  right.

  Unchanged: `config.ignore` and language-plugin drop patterns are globs by contract and still go
  to the walk, so no `.gitignore` negation can rescue a file they exclude.

- 85ade16: Give paths and qualified names one grammar, applied everywhere they are read

  Four places asked overlapping questions about the same strings and answered differently, so
  a value could pass every gate and break something that trusted it.

  **One path rule.** IR integrity invariant #10 carried its own copy of the workspace-relative
  path rule, and that copy checked only backslashes and absolute prefixes. An IR whose
  `symbols[].source.file` read `../../../../etc/passwd.ts` — or whose `components[].roots` /
  `workspace.managers[].roots` pointed above the workspace — produced zero violations, while
  `readIR` uses `assertIRIntegrity` as its only validation gate. `workspace.root` anchors every
  path in a Document, so a path that ascends past it names something the Document has no way
  to be about. Invariant #10 now calls `posixWorkspaceRelativeViolation`, the rule the Symbol
  id constructor calls, and the shared rule additionally rejects an empty path, a
  drive-relative `C:a.ts`, and a `.` segment — `./src/a.ts` beside `src/a.ts` is one file with
  two spellings, and by §3.1 that is one file with two Symbol ids that invariant #1 cannot see
  as a duplicate.

  A file path keeps the two restrictions that belong to the id rather than to the path: it
  holds neither `:` nor `#` (the id is split on the first of each), and it is never the bare
  `.`, which names the workspace root. `toPosixRelative` applies those too, since everything
  it returns becomes a `source.file` and the file segment of an id.

  **One qualified-name rule, applied to both places one is stored.** `makeSymbolId` dropped
  empty segments before validating them, so `A.`, `A..B`, `.` and `::` all built ids and
  satisfied `isSymbolId`. Separately, `Symbol.name` carries a qualified name of its own and
  nothing checked it at all — and it, not the qname inside the id, is what `apiFingerprint`
  and the framework classifiers hand to `lastQnameSegment`, which throws on an empty leaf.
  Both are now covered: the constructor refuses an empty segment, and invariant #17 checks
  `symbols[].name` alongside `symbols[].id`.

  **Producers that could break the tightened rules.** Two existed, and both now report against
  the input rather than the Document:

  - Glob patterns may ascend (`packages: ['../shared/*']`), and the matches became
    `workspace.managers[].roots` entries containing `..`. The file walk never followed them —
    it globs under the workspace root — so those packages contributed no Symbol, and the entry
    described a directory the scan never opened. `detectManagers` now refuses such a manifest
    with `workspace-root-outside`, naming the tool and the root. Continuing would have produced
    a Document silently missing packages the user declared.
  - The config schema's `RelativePath` constrains only `minLength` and "no backslash", so a
    `components[].roots` entry of `"../shared"` was schema-valid and copied into the IR
    verbatim. It is now checked where the config is read, so it is reported against
    `components[id=…].roots` in the config with the input-error exit code, instead of
    surfacing as an integrity violation blaming the Document at the end of the scan.

  Workspace and component roots are also normalized to Unicode NFC, matching
  `symbols[].source.file`, so one directory is not spelled two ways within one Document.

  `@aburi/core` newly exports `posixWorkspaceRelativeViolation`, `isQualifiedName` and the
  `GrammarViolation` type, so a consumer building an IR can apply the same rules the integrity
  checker will.

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

- 630460f: Make the effect-propagation sweep order sub-quadratic

  `reverseTopoOrder` re-sorted the ready set on every dequeue and shifted off its front. Both
  are linear in the size of that set, and the set is large in the ordinary case: most symbols
  call nothing, so nearly every SCC is ready from the start and the set grows to the size of
  the graph. That put the pass at `O(V² log V)` on the most common workspace shape.

  Measured on out-degree-zero symbols, before and after:

  | symbols | before    | after  |
  | ------- | --------- | ------ |
  | 5,000   | 223 ms    | 27 ms  |
  | 10,000  | 810 ms    | 54 ms  |
  | 20,000  | 3,923 ms  | 72 ms  |
  | 40,000  | 14,196 ms | 148 ms |

  A binary min-heap answers the same question the sort did — smallest ready index — bringing
  the pass to `O((V + E) log V)` and leaving the emitted permutation unchanged.

  `reverseTopoOrder` is now exported. The tie-break it implements is not observable through
  `propagateEffects`, because the SCC aggregation is commutative and both `derivedFrom` and
  the propagated entries are sorted explicitly afterwards — so pinning the permutation
  requires calling the function directly.

  `effect-propagation.md` described the pass as `O(V + E)`, which the previous implementation
  did not meet and this one still does not: the log factor is unavoidable while the spec
  mandates a deterministic minimum-index tie-break. The document now states the real bound.

- c825c74: Normalize Unicode before ordering, so canonical output is canonical

  `serializeCanonical` sorted object keys in whatever Unicode form the caller held and then
  wrote them normalized, which broke the property the function exists to provide:

  - two objects whose keys differed only in composition (`é` as one code point versus `e`
    plus a combining acute) produced different bytes, and therefore different fingerprints,
    for the same logical value;
  - keys that were distinct strings but identical once normalized were both written,
    producing JSON a parser silently collapses — an entry lost on the next read;
  - the emitted key order did not match the emitted bytes.

  Keys are now normalized first and ordered afterwards, and a post-normalization collision
  is rejected with a `CoreError` rather than written, matching how the serializer already
  treats other lossy coercions.

  Paths are normalized where they enter the process, in `toPosixRelative`. Which Unicode
  spelling a path arrives in depends on how the name was created — an archive, an HFS+
  volume, a Finder rename — and it survives copying to any platform, so one source tree could
  produce two spellings for a file and every cross-platform diff reported spurious changes.
  Normalizing at that single point keeps `symbol.source.file`, `components[].roots` and the
  Symbol id built from the same string spelled identically; normalizing inside the id
  constructor alone would have left them disagreeing, which silently degrades a rename into
  a delete-plus-add in `@aburi/diff`.

  `makeSymbolId` and `trySymbolId` normalize their parts too, before validating rather than
  after, so the ids `isSymbolId` accepts are exactly the ids the constructors can mint. That
  also keeps the id in memory and the id on disk the same string: the integrity sort check
  compares the in-memory form, so an un-normalized id could pass it and still land on disk
  out of order.

  `serializeCanonical`'s new refusal has its own error code, `canonical-key-collision`.
  Reusing `non-plain-json` would have been wrong — each key is perfectly representable, and
  it is their coexistence that is not.

- b8763eb: Make Unicode normalization total across every comparison the IR makes

  Ids and paths were normalized to Unicode NFC at the points where they enter the process, so
  the string held in memory and the string written to disk are one string. Several values that
  decide an order or an identity were not, and the missing halves were quiet.

  `effects[].target` is the clearest. `propagateEffects` orders propagated entries by
  `(id, target)`, integrity invariant #11 verifies that order against the in-memory value, and
  `serializeCanonical` writes the normalized one — so a Document could satisfy the sort
  invariant and land on disk violating it. The two spellings of `é` sort on opposite sides of
  `z`, so this is an inversion, not a near-miss.

  The rest are comparisons where one side is normalized and the other is not. That is worse
  than neither being normalized, because it turns a match into a miss:

  - `signature.inputs[].name` is compared against a call's head segment to decide that a
    parameter shadows a Symbol of the same name. A miss emits an edge to an unrelated Symbol,
    which then carries effects through propagation.
  - `ImportEdge.namespaceBinding` / `symbols[]` / `source` decide import-scope resolution. A
    miss puts the call in the `no-match` diagnostic bucket instead of `external` — the state
    that sends a reviewer looking for a typo that does not exist.
  - The `suppress` / `keep` / `dropCallees` prefixes decide whether a call is dropped. A miss
    leaves nothing in the Document to trace it back from.
  - `components[].publicApi` is deduped and sorted at collection and compared across revisions
    by `@aburi/diff`, whose base side came off disk normalized. A mismatch reports a
    `publicApiChanged` for a component nobody touched.

  All of them are now normalized where they enter: the scan pipeline's plugin boundary,
  `buildDropCFilter`, `normalizePackagePath`, and the CLI's config-component path.

  **The rule now has one home.** `ir-schema.md` §1.2 states it — every string in a Document is
  NFC, why that is load-bearing for both ordering and identity, the entry points where it is
  established, and why it is NFC and not NFKC (compatibility folding rewrites text rather than
  respelling it, collapsing distinct ids and misquoting source). The explanation had been
  repeated across `canonical.ts`, `id.ts`, `workspace.ts` and their tests; those now reference
  the section. §1 no longer says "alphabetical" and "UTF-16 code unit" in the same breath, and
  §9.4 states the propagated-effect ordering that made `target` a sort key in the first place.

  **Invariant #19** makes it checkable on a Document read off disk: `source.file`,
  `effects[].target`, `calls[].target`, `components[].roots`, `components[].publicApi`,
  `workspace.managers[].roots` and both `dependencies[]` endpoints. Ids and `Symbol.name` are
  left to #17 — all three grammars are ASCII-only, so a non-NFC value fails the grammar first
  and reporting it twice would have the reader chase one string twice. Strings the Document
  quotes are excluded for the opposite reason: their spelling decides nothing, and normalizing
  a quotation would misquote it.

  Normalization violations now name both spellings by code point. They render identically by
  definition, so the old message showed a string that looked correct beside the claim that it
  was not. The Symbol id constructor's version of the same message was fixed with it.

- 667f9b7: Say which files a scan lost and what to do about each, instead of a bare histogram

  The stderr report named how many files contributed no Symbols and never which, let alone why:

  ```
  ⚠ 412 file(s) contributed no Symbols: parse-timeout=412
  ```

  `@aburi/core` writes a `detail` on every entry it produces — the size against the cap, the parse
  error that refused the file, the `readFile` errno, the message a plugin threw — and
  `summariseSkipped` took `readonly { reason: string }[]`, so the path and the detail were dropped
  structurally before the line was built. The same run now reads:

  ```
  ⚠ 5 file(s) contributed no Symbols: over-size=3, parse-failed=1, extraction-failed=1
  ⚠ over-size (3) — larger than maxFileSizeBytes. Raise the budget, or leave them out with ignore.
      vendor/bundle.js: 2100000 > 1048576
      vendor/legacy.js: 1400000 > 1048576
      public/data.js: 1100000 > 1048576
  ⚠ parse-failed (1) — the language plugin refused the source. Deterministic: fix the file, or the plugin.
      src/broken.ts: parse reported a non-recoverable error at 12:4 — unterminated string
  ⚠ extraction-failed (1) — a plugin threw while extracting. This is the reason the run does not exit clean.
      src/route.ts: qualified name "{ GET, POST }" contains the non-identifier segment "{ GET, POST }"
  ```

  **The listing is the only account there is, for half the reasons.** `over-size`, `unroutable`,
  and an `unreadable` raised during discovery are decided before extraction and are not logged at
  all; the other three log per file through the run's `Logger`, which `ABURI_LOG_LEVEL=error`
  silences and which never reaches a caller who injected its own streams. Turning down log noise in
  CI used to remove the only record of which files were lost — and for a file withdrawn by its
  parse, the skip detail is the only account of the error that refused it, since counting that
  error among the recoverable ones would call it something the plugin did not.

  **One line per reason, because they want different answers.** `over-size` points at
  `maxFileSizeBytes`, `parse-timeout` at `parseTimeoutMs` and a re-run, `unreadable` at permissions
  or a tree that was changing under the scan, `unroutable` at a bug in the plugin set, and the two
  extraction reasons at the source and at the plugin. The re-run / fix-something split is the one
  `SkippedFile.reason` already draws in the IR schema, rather than a second vocabulary. The advice
  and the order both come from one `Record` over the reason union, so a reason added to the schema
  stops the build instead of printing a group with nothing to say — or, had the order been a list,
  compiling and quietly leaving that reason's files out of a report whose census still counted
  them.

  **Ten files per reason, not ten across the listing.** One shared budget belongs to whichever
  reason lost the most files, and that is not the reason a reader most needs named: a hundred
  over-size files would push the one file a plugin threw on — the only reason that moves the exit
  code to `3` — inside `…and N more`, leaving a non-zero status with nothing on screen to account
  for it.

  **`extraction-failed` is listed by that rule rather than by one of its own.** It had a separate
  clause with its own listing, which meant its files were named twice: the scan writes the thrown
  message to both `skipped[].detail` and `extractionFailures[].message` at a single site.
  `ScanReport.extractionFailures` is unchanged — it still carries the error's `code`, still decides
  the exit code, and is still what the `diff` fault clause counts.

  **Reasons are reported in a fixed order** — `over-size`, `unreadable`, `unroutable`,
  `parse-failed`, `parse-timeout`, `extraction-failed`, the order the schema's `reason` enum
  declares — in the census line and in the groups alike. Insertion order is scan order, so the census
  used to list its reasons in an order that depended on where in the workspace the losses happened
  to sit.

  **In `@aburi/core`, a timed-out file's detail now names the numbers.** It read
  `extraction exceeded parseTimeoutMs`, a restatement of the reason, while the elapsed and the
  budget — the pair that decides whether to raise the budget or go and look at the file — sat only
  in the log line beside it. A machine-dependent number is safe there because `detail` is never
  projected into the Document; `stats.skippedFiles[]` still carries `path` and `reason` only, which
  is what keeps two checkouts of one commit byte-identical.

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
