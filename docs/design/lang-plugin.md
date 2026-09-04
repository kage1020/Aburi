# Language Plugin Interface

Definition of the plugin interface for adding a new language to Aburi's extraction pipeline.
One language plugin is responsible for one `language` id (e.g. `ts` / `py` / `go`) and produces Symbol candidates and AST metadata from source strings.

References:
- [`ir-schema.md`](./ir-schema.md) — the structure of the Symbols to produce
- [`fingerprint.md`](./fingerprint.md) §5 — the input contract for the syntax fingerprint
- [`extension-vocab.md`](./extension-vocab.md) — manifest and vocab registration
- [`drop-list.md`](./drop-list.md) — where drops are applied

---

## 1. Purpose

Keep the extraction pipeline language-agnostic while accommodating each language's AST shape, naming conventions, and syntactic sugar.

The core (`@aburi/core`) knows nothing about languages. It receives input normalized into the common Symbol shape and performs effect classification, decoration removal, fingerprint computation, and diff computation.

## 2. Plugin Responsibilities

### 2.1 In scope

- Declare the file extensions of its language
- Parse sources and hold an internal AST
- Extract **all Symbol candidates** from the AST (drop determination is the core's job, but the plugin must provide all the material for it)
- Extract each Symbol's Signature, Decorator, Visibility, SourceRange, qualified name, and derivedBy (language-level)
- Walk each Symbol body and extract **Rules** and **call_expressions**
- Produce a **normalized AST string** per Symbol (the syntax fingerprint input)
- Extract import statements and return them as `ImportEdge[]`
- Report language-specific **file-level / symbol-level drop hints** to the core

### 2.2 Out of scope

- Effect classification (= responsibility of effect plugins)
- Boundary determination for decorators (= responsibility of framework plugins)
- Computing `Symbol.fingerprint.api` / `.logic` (= the core computes these from the normalized IR)
- Hashing `Symbol.fingerprint.syntax` (= the core hashes the plugin's string output)
- Applying config.suppress / config.keep (= the core does this during drop-list evaluation)
- Call resolution (filling in `calls[].resolved`)
- Building cross-language Dependencies (the core builds them from import edges)
- Generating the Markdown projection

Keeping the responsibilities narrow lets a new language addition focus solely on AST extraction.

## 3. Lifecycle

```
1. The registry validates the manifest and loads the plugin
2. plugin.init() is called with ctx (registry/config)
3. For each file matching the language:
     a. plugin.parseFile(file) → ParseResult { tree, errors, imports }
     b. plugin.extractSymbols(tree, ctx) → SymbolCandidate[]
     c. For each SymbolCandidate:
          plugin.walkBody(symbol, ctx) → BodyExtraction { rules, calls, returns }
          plugin.normalizeAst(symbol) → string  (syntax fingerprint input)
     d. plugin.releaseTree?(tree) — on every way out of a–c, including a throw
4. After all files, plugin.cleanup?() is called
```

The core then performs effect classification, drop-list application, and fingerprint computation.

## 4. Interface

The actual types are defined in the `types` package of `@aburi/core`. This document shows the signatures as a contract.

### 4.1 `LanguagePlugin`

```ts
interface LanguagePlugin {
  manifest: PluginManifest                     // type: "lang"

  // the LanguageId this plugin owns — the prefix on every Symbol id it produces, and
  // what core projects into IR.workspace.languages. Constrained to ^[a-z][a-z0-9]*$ by
  // aburi.ir.v1, so it is NOT the manifest name ("lang-typescript" is a plugin ref).
  languageId: LanguageId                       // e.g. "ts"

  // file matching (extensions only, not globs)
  fileExtensions: string[]                     // e.g. [".ts", ".tsx", ".mts", ".cts"]

  // capabilities (§6)
  capabilities: LanguageCapabilities

  // lifecycle
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // extraction
  parseFile(file: SourceFile): Promise<ParseResult>
  releaseTree?(tree: ParsedTree): void          // free the handed-over tree (§8.1); the core
                                                // calls it once, after the last reader below
  extractSymbols(tree: ParsedTree, ctx: ExtractionContext): SymbolCandidate[]
  walkBody(symbol: SymbolCandidate, ctx: WalkContext): BodyExtraction
  normalizeAst(symbol: SymbolCandidate): string

  // per-file / per-symbol drop hints (optional)
  fileDropPatterns?: string[]                  // language-specific globs (e.g. ["**/*.d.ts"])
  symbolDropHint?(symbol: SymbolCandidate, ctx: ExtractionContext): DropHint | null
}
```

### 4.2 `SourceFile` / `ParseResult`

```ts
interface SourceFile {
  path: string                                 // workspace-relative POSIX
  content: string                              // UTF-8
}

interface ParseResult {
  tree: ParsedTree | null                      // plugin-internal type (opaque); null → parse produced nothing
  errors: ParseError[]
  imports: ImportEdge[]
}

interface ParseError {
  message: string
  line: number                                 // 1-based
  column: number                               // 1-based
  recoverable: boolean                         // false → the core withdraws this file (§7.1)
}

interface ImportEdge {
  source: string                               // verbatim string (e.g. "@billing/domain", "./util")
  symbols: string[] | '*'                      // named-import symbol names, or "*"
  line: number
  dynamic: boolean                             // true for import()
  namespaceBinding?: string                    // the local name bound to the whole module, when there is one
}
```

`tree` is nullable so a plugin can report a parse that produced nothing without fabricating a tree its own type would refuse. It and `recoverable: false` are companion signals: a plugin that has no tree is expected to say why in `errors[]` too, and §7.1 reads the two as one condition, so a plugin that sets only one still gets the withdrawal it asked for.

### 4.3 `SymbolCandidate`

```ts
interface SymbolCandidate {
  // precursor of an IR Symbol; the full set before drop determination
  id: SymbolId                                 // <language>:<file>#<qname>, from makeSymbolId
  kind: SymbolKind                             // ir-schema §5.1 enum
  extKind: string | null                       // §5.2 (chosen from what the plugin itself declared)
  name: string                                 // qualified name
  visibility: Visibility
  decorators: Decorator[]
  signature: Signature | null
  source: WrittenSourceRange                   // SourceRange with both columns required (see below)
  derivedBy: string[]                          // language-level evidence (e.g. ["export-keyword"])

  // internal handles passed to walkBody / normalizeAst
  bodyNode: OpaqueAstNode | null
  mergedDeclarations?: MergedDeclaration[]     // §4.3.1, absent when one declaration wrote it
  fullNode: OpaqueAstNode                      // signature + body
}
```

`id` is a `SymbolId`, not a `string`: the type is nominal ([ir-schema.md](./ir-schema.md) §3.5), so a plugin cannot hand core an id it assembled by concatenation. Build it with `makeSymbolId` from `@aburi/core`, which enforces the §3.1 grammar — a lowercase-ASCII language token that is not reserved, a POSIX workspace-relative path, and an identifier-like qualified name — and throws a coded `CoreError` otherwise. `trySymbolId` is the non-throwing variant, for a plugin that assembles speculative ids and expects some of them not to be buildable.

A brand can be asserted rather than constructed, so the type is a contract, not a lock. Do not take that route: a plugin whose qualified names the §3.2 grammar cannot express — Ruby's `save!` and `valid?` are the standing example — must **widen the grammar**, not cast around it. The call-graph resolver and the LSP enrichment tier build candidate ids through `trySymbolId` and treat a refusal as "no such callee", so an id the constructor would have rejected resolves against nothing while looking like an ordinary miss. `assertIRIntegrity` catches it at the end of the scan (§14 invariant #17) and names the offending id, so it surfaces as a failure rather than as silently thinner output — but the diagnostic bucket in [call-resolution.md](./call-resolution.md) §8.1 has no way to say "the grammar refused this candidate", so the reason will not appear in `stats.callResolution`.

`source` is a `WrittenSourceRange`, not the IR's `SourceRange`: `startColumn` and `endColumn` are **required** on the write side, carrying `null` when the plugin cannot determine a column. This is the Class A rule of [ir-schema.md](./ir-schema.md) §1.1 expressed as a type. The narrowing matters because the canonical serializer drops properties whose value is `undefined` — a plugin that left the keys off would type-check against the wider `SourceRange` and then emit a document missing them, with nothing between the two to notice. The IR's own `SourceRange` stays optional so that a document written before the rule remains representable when it is read back off disk.

A plugin that has real column information may write it; nothing forbids that. The in-tree TypeScript plugin deliberately does not, so that every column in an Aburi IR comes from `textDocument/documentSymbol` ([lsp-enrichment.md](./lsp-enrichment.md) §4.2) and one convention about what a column counts. Be aware that a published column is not durable: the enrichment pass overwrites both keys on every Symbol it matches (§5), so a plugin-written column survives only where the LSP tier produced nothing — which is where it is least likely to be checked.

When the plugin chooses an `extKind` from its own declarations, the chosen value must fall under manifest.provides.extKinds or extKindPrefixes. The registry detects violations at startup.

#### 4.3.1 One entity, several declarations

A Symbol id names an entity, not a declaration, and most languages let one entity be written more than once: a getter beside its setter, an overload beside its implementation, an interface reopened, a namespace augmenting the class above it, a partial class. **A plugin emits one SymbolCandidate for all of them.** Two candidates sharing an id is not a thinner IR but no IR at all — [ir-schema.md](./ir-schema.md) §14 invariant #1 is checked once over the finished document, outside the per-file boundary of §7.2, so the whole run ends on it and every other file goes with it.

Which declaration leads is the plugin's to decide and to say in its own tests; what the interface fixes is where the rest goes. `bodyNode` / `fullNode` are the leading declaration's, and `mergedDeclarations` holds the others **in source order**, so that `walkBody` and `normalizeAst` describe the entity rather than whichever declaration was written first — a `set password(v)` that hashes the value has effects, and dropping it because a getter was written above it loses them with nothing to say so.

```ts
interface MergedDeclaration {
  bodyNode: OpaqueAstNode | null
  fullNode: OpaqueAstNode
}
```

Each entry carries **both** nodes, for the reason the Symbol itself does: a declaration with no body — an enum, a type alias, a namespace whose statements are their own Symbols — is described by its `fullNode`, which is where `normalizeAst` already looks when a Symbol has no body. An entry holding only a body makes a reopened `enum E {}` fingerprint as though the second declaration had never been written, so adding, editing or deleting it changes nothing. Only the bodies belong in the body walk: a merged namespace walked here would be walked a second time through the member Symbols its statements already produce.

Everything list-shaped on the Symbol joins the same way — `derivedBy` and `decorators` both. Dropping a merged declaration's decorators is not cosmetic: an `interface P {}` written above an `@Controller() class P {}` is legal, so the leading declaration is the one carrying none, and a lost `boundary` decorator moves the Symbol back inside the drop list ([drop-list.md](./drop-list.md) §4.1).

The field is optional, **absent and never empty**, so a Symbol with one declaration — the ordinary case — does not carry the key at all. A consumer that reads only `bodyNode` is correct on those, and every path that predates the field still is; a consumer that describes the Symbol from its declarations reads both.

Nothing in the core checks that a plugin folded its declarations — the invariant catches the omission, and it catches it at the end of the run. `derivedBy` is where a plugin says a fold happened; the in-tree TypeScript plugin writes `declaration-merged`.

### 4.4 `BodyExtraction`

```ts
interface BodyExtraction {
  rules: Rule[]                                // ir-schema §8
  calls: CallCandidate[]                       // raw calls before effect classification
}

interface CallCandidate {
  target: string                               // string representation of the callee (before whitespace normalization)
  line: number
  argumentCount: number                        // effect plugins reference this as needed
  inAwait: boolean                             // true when under an await
  inNew: boolean                               // true when a new expression
  literalArgs: (string | null)[]               // literal value of each argument (null if not a literal)
  dynamicReceiver?: boolean                    // optional; true when the receiver was an expression
}
```

walkBody **must not emit trivial returns as rules** (drop-list §5.3-5.5).
For call-only returns such as `return foo()`, the call goes into CallCandidate but not into a Rule.

#### Normalized-callee contract

`target` is **non-empty**, and every `.`-separated segment of it is non-empty. A leading,
trailing, or adjacent dot (`".create"`, `"prisma.user."`, `"prisma..create"`) is a
contract violation, not an input an effect plugin has to tolerate: `"prisma..create"`
splits into three segments and would match a delegate-call shape that never existed in
the source. The same holds for the `ImportEdge` of §4.2 — `source` is a normalized,
non-empty module specifier.

Whitespace is not part of the rule: a segment or specifier is rejected when it is empty,
not when it is blank. `"prisma. .create"` satisfies the contract as written — plugins are
free to be stricter, but the shared guards are not.

Consumers enforce this rather than work around it. `assertNonEmptySegments`,
`assertImportEdgeSource`, `assertImportBinding` and `hasMatchingImport` in
`@aburi/plugin-registry/plugin-input` are the shared guards. They throw, and a violation
propagates rather than degrading to an unclassified call
([`effect-plugin.md`](./effect-plugin.md) §10, EP3a), so an unnormalized callee surfaces
as a failed scan instead of a silently miscategorized effect.

Because the guards throw, the producing side has to hold the line rather than pass the
problem on. A source construct that would yield an empty specifier is legal to write —
`import x from ""` parses, and `tsc` rejects it at resolution as TS2307 — so the plugin
emits no edge for it and records a **recoverable** `ParseError` at the specifier's position.
The file keeps its Symbols (a file is withdrawn when its parse returns no tree, which this
is not), the diagnostic carries a line to fix, and the guard stays a signal that something
upstream is genuinely broken.

#### `dynamicReceiver`

Set it to `true` when the callee's receiver was an **expression rather than a name** — `getRepo().save()`, `items[0].save()`, `(a ?? b).save()`. Leave it absent otherwise; absent means `false`, so existing plugins stay valid without a change.

Normalization is lossy here in a way only the plugin can repair: `getRepo().save()` collapses to the target `getRepo.save`, which is spelled exactly like a genuine `Class.method` qname. Without the flag, [`call-resolution.md`](./call-resolution.md) §8.1 would have to file every such call under `no-match` and send reviewers hunting for a typo that does not exist; with it, the call is correctly reported as `dynamic`.

Do **not** set it for `this.save()` / `super.save()` — §4.7 already keeps those unresolved through a separate rule, and the resolver buckets them itself. Be conservative: a receiver shape the plugin does not model (a non-null assertion, a type assertion) is not evidence of dynamic dispatch, and over-reporting would make the bucket useless. The flag never affects which calls resolve — it only decides which diagnostic bucket an already-unresolved call lands in.

### 4.5 `ExtractionContext` / `WalkContext` / `FrameworkClassifyContext`

```ts
interface ExtractionContext {
  file: SourceFile
  registry: VocabRegistry                      // ext-vocab §7
  config: AburiConfig
}

interface WalkContext extends ExtractionContext {
  symbol: SymbolCandidate
}

interface FrameworkClassifyContext extends ExtractionContext {
  imports: readonly ImportEdge[]               // the same edges parseFile produced for the file
}
```

`FrameworkClassifyContext` is what a framework plugin's `classifySymbol` receives (§5.2). A plugin with no use for the edges may declare the parameter as the supertype `ExtractionContext` and still satisfy the interface.

The array is the live one, not a copy — the same instance the pipeline reports as the file's imports and hands to call resolution — hence `readonly`. A plugin may memoize per file on its identity; it must not mutate it.

### 4.6 `DropHint`

```ts
interface DropHint {
  reason: string                               // goes directly into the IR Symbol.dropReason
  category: 'B' | 'C'                          // category per drop-list §2
}
```

Example: for TypeScript's `export type X = Y`, return `{ reason: "type alias", category: "B" }`.

### 4.7 `PluginContext`

```ts
interface PluginContext {
  registry: VocabRegistry
  config: AburiConfig
  workspaceRoot: string                        // absolute path (used by the plugin to initialize its parser)
  log: Logger
}
```

## 5. Cooperation with Other Plugins

### 5.1 Cooperation with effect plugins

The language plugin's job ends at returning `CallCandidate[]`. The core queries the effect plugins in order for each call, and the result of the first plugin to return an `EffectClassification` is adopted.

- A call for which every effect plugin returned null → stays in `Symbol.calls[]` (target/line/resolved=null)
- A call classified by some effect plugin → goes into `Symbol.effects[]` and not into `Symbol.calls[]` (ir-schema §9.3)

See [`effect-plugin.md`](./effect-plugin.md) for the detailed interface.

### 5.2 Cooperation with framework plugins

The language plugin extracts each Decorator up to its **raw string, arguments, and name**. The `boundary` flag is filled in by the core querying the framework plugin.

#### 5.2.1 First-match-wins among framework plugins

When multiple framework plugins are enabled in the config, **first-match-wins in config order**, just like effect plugins (same convention as [`effect-plugin.md`](./effect-plugin.md) §5.1):

- Each SymbolCandidate is passed to the framework plugins' `classifySymbol` in config order
- The result of the first plugin to return non-null is adopted (extKind / boundary adjustments, etc.)
- Subsequent plugins are skipped

This avoids ambiguous states such as "the same class is recognized as both a NestJS Controller and a Custom Framework Controller". If a project has conflicts, priority is controlled via config order.

A framework plugin receives the following inputs:
- the `SymbolCandidate` (including decorators)
- the file's `ImportEdge[]`, on `FrameworkClassifyContext` (§4.5)
- the framework declaration of the owning component

Against these it may:
- override `decorator.boundary`
- fill in `Symbol.extKind` (e.g. `framework:nestjs:controller`)
- provide a Category B drop exclusion hint (e.g. a class carrying only `@Module` must not be treated as a pure DTO)

The detailed interface is deferred to a future `framework-plugin.md` (this document only reserves the contract surface).

#### 5.2.2 Matching a decorator against the import edges

The language plugin reports a decorator under the identifier the source wrote. That identifier is not reliable evidence on its own, in either direction: `import { Controller as Ctrl }` writes a framework boundary under a name no table holds, and a `@Controller` from a competing library writes a foreign name that every table holds. A plugin that matches names against its vocabulary resolves the identifier through `ctx.imports` first:

| What the edges say about the written name | Match against | Confidence |
|---|---|---|
| imported from a module the plugin owns | the imported name | `high` |
| imported from any other module | the imported name | `medium` |
| not named on any edge | the written name | `high` |

The middle row **downgrades rather than refuses**. Re-exporting a framework's vocabulary through a project-local barrel is ordinary practice, and a barrel reached through a build-tool path alias (`@app/common`) is indistinguishable from a foreign package without reading the build config — so refusing would take the boundary off a whole project's worth of Symbols to close a narrower false positive. `medium` is the `confidence` criterion for an identifier match (`ir-schema.md` §5.4), which is exactly what is left when provenance is unknown.

Two consequences follow for the plugin's outputs. `SymbolClassification.decoratorBoundaries` is keyed on the **written** name, because that is what the core matches against `Decorator.name` when it folds the result back in. `derivedBy` carries the **imported** name, because it is a closed vocabulary that diffs and filters read, and renaming an import changes nothing about what the decorator does.

A qualified decorator (`@nest.Controller()`) reaches the plugin as its leaf identifier; `Decorator` carries no qualifier, so it cannot be tied back to a namespace edge and falls in the last row. That row is therefore the one place the table is not ordered by how much the file disclosed: a namespace import from a competing library is trusted further than the named import of the same decorator, and nothing available at this layer can separate them.

Two shapes reach the edge list without binding anything in local scope, and a plugin matching names should know both. A re-export (`export { X } from './y'`) names a symbol the file republishes rather than uses — and its aliased form arrives as the source-side name alone, since the language plugin composes `" as "` on imports but not on re-exports. Because re-exports do not bind, a name can appear on two edges in a file that compiles, so a plugin needs a duplicate rule and should say which of its outcomes are order-independent.

### 5.3 Extraction order

```
plugin.parseFile()                              [lang]
  ↓
plugin.extractSymbols()                         [lang]
  ↓
framework plugin classifySymbol()               [framework]
  ↓
plugin.walkBody()                               [lang]
  ↓
effect plugin classify() for each call          [effects]
  ↓
plugin.normalizeAst()                           [lang]
  ↓
core applies the drop list / computes fingerprints
  ↓
plugin.releaseTree()                            [lang, called by the core — §8.1]
  ↓
core assembles the IR
```

## 6. Capabilities

`LanguageCapabilities` is a flag set through which the plugin declares "what is expressible in my language". The core and other plugins use it for branching.

```ts
interface LanguageCapabilities {
  hasDecorators: boolean
  hasGenerics: boolean
  hasAsync: boolean
  hasMacros: boolean
  hasPatternMatching: boolean
  hasAbstractTypes: boolean                    // abstract class / trait / interface
  hasModules: boolean                          // ES module / Python module / Go package
  hasNamespaces: boolean                       // TS namespace / C# namespace
  hasTypeParameters: boolean
  hasExplicitVisibility: boolean               // public/private keywords
  hasJsDoc: boolean                            // JSDoc / docstrings, etc.
}
```

For the runtime resource budget (`wasmHeapPerWorkerMB`), the source-of-truth is the **`capabilities` of the plugin manifest**, not the runtime interface. The CLI reads the manifest to control concurrency, so it is not duplicated at runtime (see §8.1 / cli-spec.md §11).

If a framework plugin requires decorator-based extraction from a language with `hasDecorators: false`, the core aborts with an error at startup.

## 7. Error Handling

### 7.1 Parse errors

- `recoverable: true` → the core proceeds to Symbol extraction (tree-sitter is normally recoverable)
- `recoverable: false` → the core **withdraws the file**: no Symbols reach the IR, it is recorded in `ScanResult.skipped` with `reason: "parse-failed"` and a detail quoting the error's message and position, it is excluded from `stats.parsedFiles` while still counting toward `stats.totalFiles`, and the core logs a warning. Read as exactly `false`, not as falsiness: plugins arrive as plain JavaScript, and a plugin that omits the key gets the behaviour it had before the field was read at all rather than having every file it warned about withdrawn.
- A `tree` of `null` withdraws the file on the same terms, and is expected to carry a `recoverable: false` error beside it (§4.2). The two are read as one condition, so a plugin that sets only one still gets what it asked for — and a plugin that built a usable tree and then decided the file must not be used (a wrong dialect, a generated blob) does not have to discard the tree to say so.
- Its **parse errors are still reported** on `ScanResult.parseErrors`, for the reason §7.1.2 gives: they are diagnostic rather than IR, and here they are the entire account of why the file went.
- Its **import edges are kept** — the one place this differs from a file abandoned on its `parseTimeoutMs` budget, which is being withdrawn deliberately. A file whose contents could not be used still told us truthfully what it imports. Nothing consumes them yet: call resolution looks the list up by the file a Symbol came from, and a withdrawn file has none, so the entry waits for the dependency-extraction pass.
- `aburi scan` stays at exit `0`. An unparseable file is a property of the source, like an over-size or timed-out one; no skip reason moves the code by being that reason, and `extraction-failed` alone moves it by being one (§7.2, cli-spec.md §5.4). What does move it regardless of reason is how much was lost: a scan that parsed nothing exits `3`, as does one that fell below a `minParsedFileRatio` the workspace set (cli-spec.md §5.7). Refuse every file in a workspace and the run is not green.
- warning stderr: `Skipped <file>: parse reported a non-recoverable error at <line>:<column> — <message>`. With no tree and no such error, the first recoverable one is quoted instead — `Skipped <file>: the language plugin returned no tree; first error at <line>:<column> — <message>` — because a withdrawn file is excluded from the CLI's recoverable-error count and this line is then the only place its errors can be read. `Skipped <file>: the language plugin returned no tree` when there were none at all.

### 7.1.1 Large-file skip

Files whose size exceeds `config.maxFileSizeBytes` (default: `2 * 1024 * 1024` = 2MB) are skipped without parsing.

- Normal code does not exceed 2MB (only generated bundles / minified files do)
- Large files exhaust the WASM heap and make parse time explode
- Skipped files are returned on `ScanResult.skipped` with `reason: "over-size"` and named in the Document at `stats.skippedFiles[]` (ir-schema.md §2), so a later `aburi diff` can tell a file that was never read from one whose API was deleted
- warning stderr: `Skipped <file>: <size>MB exceeds maxFileSizeBytes (2MB). Override with config.maxFileSizeBytes.`

### 7.1.2 Timeout

If the total of parse + extractSymbols + walkBody for one file exceeds `config.parseTimeoutMs` (default: `5000` = 5 seconds; the config schema's minimum is 100 and it has no maximum), abort, skip that file, and warn.
This prevents a broken grammar or pathological source (deep nesting, etc.) from stalling the whole run.

The budget is **cooperative**, for the reason [effect-plugin.md](./effect-plugin.md) §5.1.1 gives for the classify budget: `extractSymbols` and `walkBody` are synchronous plugin calls, and nothing can interrupt one that has already started. It is read at the three points that bound the work still to come — after `parseFile`, after `extractSymbols`, and before each candidate's `walkBody` — so what it guarantees is that an over-budget file is handed no *further* work. A file costs at most its budget plus one stage, and one enormous candidate can still overrun by however long that candidate takes. A hang inside a single call is not something a wall-clock budget can catch at all.

An aborted file contributes **nothing to the IR**: no Symbols, no import edges, and no `stats.effectClassifyTimeouts` entries accumulated from the candidates it did finish. Keeping whichever Symbols it produced before the budget ran out would make the Document depend on how fast the machine was that day, so the outcome is binary per file. It is recorded in `ScanResult.skipped` with `reason: "parse-timeout"`, repeated on `ScanResult.parseTimeouts` with the budget and the elapsed, and excluded from `stats.parsedFiles` while still counting toward `stats.totalFiles`.

Its **parse errors are still reported**. They are diagnostic rather than IR, and they are what a slow file most needs to keep: backtracking over malformed input is a common reason for a slow parse, so a run that swallowed them would tell the reader to raise `parseTimeoutMs` when the fix is the syntax. A file that is both broken and slow appears in `parseErrors` and in `parseTimeouts` — but never in both `parseTimeouts` and a §7.1 withdrawal. The withdrawal is decided before the first deadline reading, and the two would compete for the one `skipped` entry the file gets: a plugin's outright refusal reported as a file that was merely slow sends the reader to raise a budget that was never the problem.

- warning stderr: `Skipped <file>: extraction reached <elapsed>ms, exceeding parseTimeoutMs (<budget>ms). Override with config.parseTimeoutMs.`

A file being skipped on wall clock does mean the IR can differ between a fast machine and a slow one, at file granularity. That is inherent in asking for a time budget; a run that wants reproducibility across machines sets `parseTimeoutMs` high enough that nothing reaches it.

### 7.2 Extraction exceptions

- If any plugin call for a file throws — `parseFile`, `extractSymbols`, `symbolDropHint`, `walkBody`, `normalizeAst`, a framework `classifySymbol`, or an effect `classify` — the core withdraws **that file** and keeps going. One file's bug does not halt IR generation.
- The withdrawn file is named in `ScanResult.skipped` with `reason: "extraction-failed"`, and the thrown message is kept beside it in `ScanResult.extractionFailures`. The core logs a warning per file; `aburi scan` exits `3` when the list is non-empty, so a run that dropped a file is not green.
- The file loses its recoverable parse errors, unlike one abandoned for its `parseTimeoutMs` budget: the pipeline result never materialized, so the thrown message is the diagnostic in their place.
- **Some are not absorbed.** An error whose code names a fault in the plugin *set* rather than in the file propagates and ends the run, because it repeats for every file and withdrawing them one at a time would report the workspace as broken instead of the plugin. Today that is `scan-plugin-misconfigured` (an effect plugin returning a Promise from `classify`, a language plugin emitting Symbol ids with no language prefix), `invalid-language-id` (the prefix is present but is not a legal `LanguageId`, which comes from the plugin's own `languageId`), and `vocab-undeclared` (an id the emitting plugin's manifest does not claim — `effect-plugin.md` EP1). Everything else describes the file — `anonymous-symbol-id-attempted` from a qualified name the grammar refuses, `non-posix-path` from where the file lives — and is absorbed.
- A plugin-wide bug that carries none of those codes still presents as one failure per file rather than one crash. That is the intended shape — every file named, the messages identical, the count the whole workspace — but it is a weaker diagnostic than a code that says outright what is wrong.
- The behaviour above is unconditional: there is no "stop at the first extraction exception" mode. (`config.strict` is defined for something else — undeclared-vocab strictness — and has no reader yet either way.)

### 7.3 Manifest violations

- If a plugin puts an `extKind` not declared in its manifest into a SymbolCandidate → extraction-time error (drop-list §6.3 / extension-vocab §6.3)
- In `--discover` mode this is downgraded to a warning (extension-vocab §11.5)

### 7.4 Syntax the language plugin does not support

- Example: the TS plugin encounters an unknown syntax element (a future TS language extension) → skip without creating a SymbolCandidate, debug log
- This is not an error (to allow incremental support of new syntax)

## 8. Parser Implementation Options

A language plugin may choose its parser freely, provided it satisfies the following:

- Position information (line/column) is available per node
- Recovery from partial parse failures is possible (recommended)
- Node kinds are distinguishable (statement / expression / declaration classification)
- Access to a raw AST that **does not desugar** the language's syntactic sugar (e.g. does not collapse `async function` into `function` + flag)

Representative options:

| Parser | Applies to | Notes |
|---|---|---|
| tree-sitter (WASM) | multi-language | rich grammars, recoverable, first choice for official Aburi language plugins |
| tree-sitter (native) | multi-language | faster than WASM but requires a node-gyp build |
| oxc-parser | TS/JS | faster than tree-sitter, TS-only |
| ast-grep | multi-language | tree-sitter based, easy pattern authoring |
| swc | TS/JS | written in Rust, TS-only |
| ruff (internal AST) | Python | written in Rust, limited public AST API |
| go/parser | Go | standard library |
| syn | Rust | proc-macro only, heavy for standalone CLI use |

The official `@aburi/lang-typescript` plugin adopts **tree-sitter WASM** for its initial implementation (proven in a PoC; zero-build on Windows is an advantage). Replacement with oxc-parser is under consideration for a later version.

### 8.1 Memory-management convention for WASM parsers

WASM parsers such as `web-tree-sitter` hold a WASM heap separate from the Node heap; there is a known issue where failing to explicitly free parser instances leads to `RangeError: WebAssembly.Memory()` crashes after parsing thousands of files.

Each plugin must follow these conventions:

1. **Release the parser and the tree, each on the side that owns it**
   - Create the parser inside `parseFile()` and call `parser.delete()` after obtaining the result. It never leaves the function, so the plugin frees it.
   - The tree is handed over. The plugin implements `releaseTree(tree)` and the core calls it once per non-null tree, after the last of `extractSymbols()` / `walkBody()` / `normalizeAst()` has read it — including when one of those threw, when the file was withdrawn, and when it ran out of parse budget. A plugin that deleted the tree on its own way out of `parseFile()` would be handing the core a dead handle.
   - The exception is a `parseFile()` that fails *after* parsing: the caller never receives the handle there, so the plugin releases the tree itself before propagating.
   - Node references taken out of the tree (`SymbolCandidate.bodyNode`, `fullNode`) are valid for as long as the tree is, which is the file's pipeline run rather than the scope of `parseFile()`. None of them may outlive the tree: what the pipeline returns is the strings and ranges read out of the nodes, never the nodes.
   - A `releaseTree` that throws is recorded on `ScanResult.treeReleaseFailures` and does not fail the file, whose Symbols are already in the IR. A `releaseTree` that is declared as something other than a function is recorded there too, saying so — it is a contract violation rather than a parser fault, and the two are not described in the same words.
2. **WASM heap budget under parallel execution**
   - `capabilities.wasmHeapPerWorkerMB` in the plugin manifest (range: 16–4096 MiB, implicit default 256 MiB when undeclared) is the source-of-truth
   - The core caps `--concurrency` at `min(specified value, floor(availableMemoryMB / wasmHeapPerWorkerMB))`
   - When multiple lang plugins coexist in the same run, the **maximum** of each plugin's declared value is used (sized for the hungriest lang)
3. **Reservation for a native-binding fallback**
   - In a future release, switching to native bindings (e.g. the `tree-sitter` Node bindings) may be added via flags such as `capabilities.preferNative` (see the [roadmap](../roadmap.md))
   - Currently only WASM is implemented; no native fallback is provided

### 8.2 Cost convention for WASM node access

The same heap boundary has a cost consequence that is easy to miss, because the JS surface hides it. A getter like `node.children` or `node.namedChildren` is not a field read: it unmarshals **every** child across the WASM boundary into a fresh JS object, and the array it returns is cached on that JS wrapper only — the next `node.parent` hands back a new wrapper and pays for the list again.

So a per-node question must be asked of the node, never of its container:

- **Ask the node**: `previousSibling`, `previousNamedSibling`, `nextSibling`, `childForFieldName`, `childrenForFieldName`. Each crosses the boundary once per node it returns, and a backwards walk over a run of siblings stops as soon as the run ends. `childrenForFieldName` is bounded by the node's own children — a handful for a declaration — and unmarshals only the ones the grammar tagged, so it is a question about the node even though it returns a list.
- **Do not ask the container**: reading the parent's whole child list to find the node's own index in it. It answers the same question, but a top-level declaration's parent is the entire file. Doing it once per declaration makes a file of N declarations cost O(N²) — the shape a generated API client or a Prisma type file has, comfortably inside `maxFileSizeBytes` and minutes long to extract.

Reading the container is right when the container is what the question is about: every member of a class body, every argument of a call. It is the *per-node* use that has to be avoided.

## 9. Verifiable Properties (Test Criteria)

Every language plugin must pass the following tests.

### 9.1 Structural extraction

| ID | Input | Expected |
|---|---|---|
| LP1 | top-level function | SymbolCandidate.kind = "function", name = the function name |
| LP2 | class | SymbolCandidate.kind = "class", name = the class name |
| LP3 | class method | SymbolCandidate.kind = "method", name = `Class.method` |
| LP4 | class static method | name = `Class::method` |
| LP5 | interface (TS/Java/Go) | SymbolCandidate.kind = "interface" |
| LP6 | default export of anonymous function | name = `<default>` |
| LP7 | `const f = () => ...` | name = `f` (the variable name becomes the qname) |
| LP7a | the same binding written behind a wrapper that says nothing about the value — TypeScript's `(f)`, `f as T`, `f satisfies T`, `f!` | the same answer as LP7. A wrapper the language uses to group, to name a type or to assert non-null does not replace the value, so the test for "is this a function?" reads through it. **One** reader answers what a wrapper is, for every question the plugin asks about a node — a binding, a member, a call's argument and a call's receiver. Two readers is the defect, not the duplication: while the receiver side hand-unwrapped only parentheses, `(app as Express).get(p, h)` was not a registration at all |
| LP7b | a **call** in the same position — `const f = withAuth(() => …)` | not a function. A call returns one by convention and nothing in the tree says so, which is the line the unwrap stops at: past it the plugin would be guessing rather than reading |
| LP8 | nested class (`Outer.Inner.method`) | the `.` nesting in name is correct |
| LP8a | a getter and a setter for one property | **one** SymbolCandidate. The two are one member, and one id can only carry one Symbol (§4.3.1) |
| LP8b | LP8a's signature | the getter's. A property's type is what reading it answers; the setter's signature is the type of writing it |
| LP8c | LP8a's bodies | both, the setter's on `mergedDeclarations`. `walkBody` reports the calls in either of them |
| LP8d | a getter with no setter, or a setter with no getter | one SymbolCandidate, nothing merged into it |
| LP8e | a static accessor pair beside an instance pair of the same name | two SymbolCandidates — `Class::v` and `Class.v` are different entities |
| LP8f | an overload declaration beside its implementation | one SymbolCandidate, and the signature and body are the **implementation's**. The overload is written first, so a rule that took the first declaration would report the member as body-less and give it the wrong parameter types |
| LP8g | a class body of overload declarations with no implementation | no member SymbolCandidate. The same answer a top-level overload with no implementation gets, so the construct does not depend on where it is written |
| LP8h | a declaration merged with an earlier one — a reopened interface or namespace, a namespace augmenting the class or function above it | one SymbolCandidate, carrying the earlier declaration's kind and range and **every** declaration's `derivedBy`. Anything the later declaration declares in turn (`N.b` from a reopened `namespace N`) is its own Symbol and must still be there |
| LP8i | a file that declares nothing twice | no evidence of merging anywhere in it, and the `mergedDeclarations` key absent — not present and empty |
| LP8j | a merged declaration that has no body of its own — a reopened `enum` / `namespace` / type alias | its `fullNode` still reaches `normalizeAst`, so editing the second declaration changes the Symbol's normalized string |
| LP8l | a declaration whose name spells a path the language treats as nesting — TypeScript's `namespace A.B {}` | one SymbolCandidate per segment, and the body under all of them. The dotted text is not one qualified-name segment, so feeding it to the id builder loses the whole file (§4.3) |
| LP8m | a member whose name is written as a **string literal** — `class C { "createInvoice"() {} }` | the segment the literal *decodes* to, when that is an identifier the qualified-name grammar admits; otherwise **no** SymbolCandidate (LP20c). A property key is a string, so the quoted and the bare spelling of one identifier are one member and fold by id (§4.3.1) — and `"constructor"() {}` is the construction path, which the language decides by the property name and not by how it is written. A literal whose contents did not wholly parse is refused: joining what parsed mints an id for a name the source does not contain |
| LP8k | a decorator written on a merged declaration that is not the leading one | among the Symbol's decorators. A `boundary` decorator lost here re-enters the Symbol into [drop-list.md](./drop-list.md) Category B |

### 9.2 Signature extraction

| ID | Input | Expected |
|---|---|---|
| LP9 | `async function f()` | signature.async = true |
| LP10 | `function* g()` | signature.generator = true |
| LP11 | `f(a: number, b: string): boolean` | inputs = [{name:"a",type:"number"},{name:"b",type:"string"}], outputs = ["boolean"] |
| LP12 | `function f<T>()` | typeParameters = ["T"] |
| LP13 | `function f() { throw new MyError() }` | throws = ["MyError"] |

### 9.3 Decorator extraction (languages with decorators)

| ID | Input | Expected |
|---|---|---|
| LP14 | `@Post('/x') method()` | decorators[0] = { name: "Post", raw: "Post('/x')", arguments: ["'/x'"], boundary: `<determined by the framework plugin>`, line: ... } |
| LP15 | two decorators | 2 entries in decorators[], **ascending by source position** — not by line, which two on one line share, and never by name, which would make a consumer that reads the first one depend on the alphabet. On a Symbol several declarations wrote (§4.3.1) the order is still source position, across all of them: the lists join in declaration order, which is why the fold visits declarations in source order rather than leading declaration first |
| LP15a | a decorated member followed by an undecorated one | the second member's decorators = [] — the run belongs to the member it sits above, and does not leak down |
| LP15b | a comment between two decorators, or between the decorators and the declaration | all of the decorators, in source order — a comment is written wherever the author put it and does not end the run |
| LP15c | a decorator the grammar parents *inside* the declaration rather than beside it (`@A() class C {}`, `export @A() class C {}`, `export default @A() class C {}`, `@A() abstract class C {}`) | read the same as a preceding one — where a decorator is written must not change what the Symbol reports |
| LP15d | a **parameter** decorator (`m(@P() x)`) | not among the method's decorators, nor the owning class's — it decorates the parameter |
| LP15e | a JSDoc block above a decorator (`/** @throws E */ @A() m() {}`) | read as the member's; the decorator does not end the comment run |
| LP15f | a decorator on both sides of `export` (`@A() export @B() class C {}`) | both. TypeScript rejects the source as TS8038, but a grammar that accepts it hands the extractor a half-edited file, and reading one side would drop a decorator from it silently |

### 9.4 Body walk

| ID | Input | Expected |
|---|---|---|
| LP16 | `if (x) throw new E()` | guard + throw in rules |
| LP17 | `return 1` | no return in rules (trivial) |
| LP18 | `return foo()` | no return in rules, foo in calls |
| LP19 | `return a + b` | return in rules (expr: "a + b") |
| LP20 | `for (let i...) ...` | loop in rules (loopKind: "for") |
| LP20a | a type whose members are Symbols of their own — a class and its methods | the owner's walk reports **its own** body only: field initialisers, static blocks, and whatever the language runs on construction. A member body reported twice is reported on two Symbols, and any resolution that reaches the owner (`call-resolution.md` CR15 resolves `new C()` to the class) carries the duplicate up into callers that touch nothing |
| LP20b | the construction path — a constructor body | reported on the owner, because that is the Symbol an instantiation resolves to, **and** on the member's own Symbol. Reporting it twice costs nothing only while no call resolves to a constructor; a resolver that grew `super()` resolution ([`call-resolution.md`](./call-resolution.md) CR18 is adjacent) would make the second copy propagate, so the plugin owes this row a check against its core. Whether a static member named `constructor` is on the construction path is the language's answer, not the name's: in ECMAScript it is not |
| LP20c | a member with **no** Symbol of its own — a computed name, a name the qualified-name grammar has no segment for (`"a-b"() {}`, `1() {}`), a member of an anonymous default export | its body stays on the owner. Skipping it would lose the calls in it with no Symbol, no diagnostic and nothing to say so. The plugin needs one predicate for "is this member a Symbol?" that both extraction and the walk read — and both must ask it about the **same owner node**. The walk reads the owner off the body it is walking, not off the Symbol: a folded Symbol's `fullNode` is its leading declaration (§4.3.1) and need not be the owner at all |
| LP20d | a member's parameter defaults | on the owner. They sit outside the member's own `bodyNode` — whatever the member's `body` is, a block or a bare expression — so skipping the whole member rather than its body loses them. Where a decorator sits is a grammar's choice and both answers are fine: in tree-sitter-typescript a method's is a sibling, so the member skip never reaches it, and a field's is a child of the field, which this rule then keeps on the owner. Both are right on the same ground — a decorator's arguments run where the decorator is applied |
| LP20f | a member written as a **field holding a function** — `create = (d) => { … }` | a member. Constructing the owner creates the closure and does not enter it, so the body is what *calling* the member runs, and LP20a applies unchanged: the body is the member's Symbol's and the owner stops carrying it. What separates it from `seed = makeSeed()`, which stays on the owner, is when the value runs — not what the member is called or how it is spelled. The function set is the one the language's module level already uses for the same decision, so `const f = …` and `class C { f = … }` are not two answers. The member's body is one level further down than a method's, so the skip follows the path to it rather than filtering the member's own children |
| LP20g | a Symbol whose declaration is a **call** that registers a function — `app.post('/users', async (req, res) => { … })` | the registered function is the Symbol's body. The registration is the only Symbol the statement produces, so a handler written inline is otherwise in no Symbol at all; and it is what the registration runs, so it is the body by the same reading as LP20a. Every function written as a **direct** argument of a call on the statement's spine counts, in source order — a chained registration (`app.route(p).get(h1).post(h2)`) is one statement and one Symbol, and so is `app.use(h0).router.get(h1)`, where a property access stands between the two calls. "Function" is the plugin's own predicate (LP7a) and no wider: a generator argument (Koa's `app.use(function* (ctx, next) {…})`) registers no body. A body of no width is refused, so a half-written handler the parser recovered does not claim one. The Symbol's `signature` stays null: it is the registration, and reading the handler's would publish the framework's callback shape as the route's API |
| LP20h | LP20g with more than one handler | the first in source order is `bodyNode` and the rest ride on `mergedDeclarations`, which is a **stretch of that field**: they are further bodies of one declaration, not further declarations of one entity (§4.3.1), and they carry no `declaration-merged`. The field is reused because every reader of it (`bodyNodesOf`, the empty-body hint) wants exactly "every body this Symbol has". A single-body reader gets the source-order-first function, which need not be the handler: `makeRouter(() => setup()).get(p, h)` leads with the factory's callback |
| LP20i | LP20g's normalized string | the **whole call**, not the body. What the registration runs is the walk's question; what it *is* — its path, its method, the middleware between them and the handler — is the fingerprint's, and narrowing to the body makes `app.get(p, authenticate, h)` and `app.get(p, h)` serialize identically. This is LP8j's rule read from the other side: a describing node dropped from the string is a change the axis stops seeing |
| LP20e | an owner-shaped node the walk *meets* rather than owns — `function f() { class Inner { m() { x() } } }` | walked whole. `Inner` is not extracted, so every call in it belongs to `f`; LP20a applies to the Symbol's own body nodes and to nothing else |

### 9.5 normalizeAst

| ID | Input | Expected |
|---|---|---|
| LP21 | code differing only in comments | normalizeAst yields identical strings |
| LP22 | code differing only in whitespace | normalizeAst yields identical strings |
| LP23 | code with different identifiers | normalizeAst yields different strings |

### 9.6 Import extraction

| ID | Input | Expected |
|---|---|---|
| LP24 | `import { X } from './y'` | imports = [{source: "./y", symbols: ["X"], line: 1, dynamic: false}] |
| LP25 | `import * as Y from 'z'` | imports = [{source: "z", symbols: "*", line: 1, dynamic: false}] |
| LP26 | `await import('./x')` | imports = [{source: "./x", symbols: "*", dynamic: true}] |
| LP26a | an empty specifier on a form the reader already produces an edge for — `import a from ""`, `import ""`, `export * from ""`, `export { X } from ""`, `import type { B } from ''`, `import("")`, `import x = require("")`, ``import(``)`` | no edge, and one recoverable `ParseError` at the literal's line and column, naming which construct it belongs to. The specifier names no module, so no edge can carry it (§4.4), and a silent drop would leave the file looking as though the import were never written |
| LP26b | an empty specifier beside a valid one | only the broken edge is withdrawn |
| LP26c | two empty specifiers, on one line or on two | two errors. Edges are deduplicated on `(line, source, dynamic, symbols)`, so the only pair that could ever have merged is two writings on one line; diagnostics are per occurrence either way |
| LP26d | a blank specifier (`import a from " "`) | an ordinary edge. §4.4 rejects empty, not blank |
| LP26e | a computed specifier — `import(p)`, `import("" + x)`, ``import(`./${p}`)`` | no edge and **no diagnostic**. The reader does not follow computed specifiers, which is not a fault in the source. Joining a substituting template's fragments would answer `"./"` here — an edge to a module nobody named, which is worse than none |
| LP26f | `import x = require('./m')`, written at the top level of a file | one edge, `{source: "./m", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x"}`. `x` binds the module object as `import * as x` does, so the namespace shape is what lets call resolution strip the head off `x.foo()` and look for `foo` in the target; a default binding (`symbols: ["x"]`) would send it looking for `x.foo` there instead. `dynamic` is false because the field means "written as `import()`" (§4.2) and this form is not |
| LP26g | `import type x = require('./m')` | the same edge. Type-only imports produce edges throughout §9.6 |
| LP26g1 | a require-equals whose argument is not a lone string literal — `require("a" + b)`, `require('./m', 'y')`, `require(f('./m'))` | no edge. Each is a syntax error the parser already reports, but tree-sitter's recovery leaves an operand it could read as a direct child of the clause with the `source` field attached, so a reader that took it would answer `a`, or the second argument. A clause that did not parse is not read |
| LP26g2 | `export import x = require('./m')`, and a require-equals inside `declare module` / `namespace` | **no edge, and the reader does not follow either form.** Both are valid TypeScript. The `export` form is a grammar gap: tree-sitter reads it as an `import_alias` with a `MISSING ";"` plus a stray parenthesised expression, so the clause never exists to be read. The nested form is the general limit of walking `root.namedChildren` — a plain `import { A } from './m'` inside `declare module` is missed on the same terms — and is softened by `.d.ts` files being dropped before extraction |
| LP26h | `import x = A.B.C` | no edge and no diagnostic. The alias renames a local namespace; no module is named |
| LP26i | `import(/* webpackChunkName: "x" */ './m')` | the ordinary dynamic edge. A comment is a named node standing in front of the specifier, and reading the first argument by position would find the comment |
| LP26j | ``import(`./m`)`` | the ordinary dynamic edge. A template with no substitution names a fixed module and is a static specifier written with different quotes |
| LP26k | a specifier carrying an escape sequence — `"./a\tb"`, `"\x2E/e"`, ``import(`./a\nb`)`` | the escape is **decoded**, not skipped: `./a`+TAB+`b`, `./e`, `./a`+LF+`b`. Skipping it answers a module that does not exist, and for an escaped leading dot it answers one that is no longer relative — so `isRelativeSpecifier` refuses it (the predicate is `./` **or** `../`) and every call through the binding is bucketed `external` rather than resolved against the sibling file it names |
| LP26l | an escape the grammar refuses — `"./a\uZZZZb"`, `"./a\xZZb"` | recoverable syntax errors from the parser, and the fragment that survived. These parse as ERROR nodes rather than `escape_sequence`, so no decoder is asked to repair source the grammar rejected. The criterion is that the grammar rejected it — see LP26n for the escapes it accepts without a legal value |
| LP26m | a literal that is only a line continuation — `"\<newline>"` | no edge, and the LP26a diagnostic. A continuation joins two source lines and contributes no character, so the literal names no module. A literal made only of *other* escapes (`"\n\t"`) is a non-empty name and gets an ordinary edge, on LP26d's terms |
| LP26n | an escape the grammar accepts and ECMAScript has no value for — `"./a\u{110000}b"`, `"./a\1b"`, `"./a\8b"` | the escape's own text, minus the backslash, with no diagnostic and no throw. The grammar checks a braced escape's shape and not its range, so `\u{110000}` reaches the reader where `\uZZZZ` does not, and `String.fromCodePoint` throws on it — which would cost the whole file. Legacy octal and non-octal decimal escapes are the same case: a SyntaxError in a module, so no correct value exists, and inventing one would put a module name in the IR the source does not contain |

### 9.7 Error recovery

| ID | Input | Expected |
|---|---|---|
| LP27 | file containing a syntax error | returns a recoverable error, extracts Symbols where possible |
| LP28 | completely broken file | returns a non-recoverable error and a null tree, the core withdraws it |
| LP28a | a file the plugin parsed but refuses — a usable tree paired with a `recoverable: false` error | the core withdraws it on the same terms as LP28. The tree is never handed to `extractSymbols`, `walkBody` or `normalizeAst`, and the refusal is quoted in `ScanResult.skipped` |

### 9.8 Symbol id construction

| ID | Input | Expected |
|---|---|---|
| LP29 | Any extracted Symbol | `SymbolCandidate.id` came from `makeSymbolId`; a hand-assembled `` `${lang}:${file}#${qname}` `` does not type-check against `SymbolId` (§4.3) |
| LP30 | A qualified name the §3.2 grammar rejects (empty, anonymous marker, non-identifier segment) | `makeSymbolId` throws a coded `CoreError`; the id never reaches the IR |

### 9.9 Tree lifetime (§8.1)

| ID | Input | Expected |
|---|---|---|
| LP31 | A plugin holding a resource its trees do not release on their own | it implements `releaseTree`, and a tree passed to it is unusable afterwards |
| LP32 | Many files scanned in one process | the parser's heap does not grow with the file count — the core released every tree the plugin handed over |
| LP33 | A file whose `extractSymbols` / `walkBody` / `normalizeAst` throws, is withdrawn, or overruns `parseTimeoutMs` | its tree is released all the same; the diagnostic the file was already carrying is what the caller sees |
| LP34 | A `releaseTree` that throws | the file keeps its Symbols and its exit code; the plugin, the file and the message are on `ScanResult.treeReleaseFailures` |

## 10. Design Decisions

### 10.1 Why effect classification is excluded from the plugin's responsibilities

If language plugins carried effect classification, `@aburi/lang-typescript` would have to know hundreds of call patterns for Prisma/Drizzle/Stripe and so on. To avoid responsibility bloat, the separation is strictly enforced: **language plugins handle structure, effect plugins handle identifier patterns**.

### 10.2 Why the final drop decision is excluded from the plugin

The drop list ([`drop-list.md`](./drop-list.md)) is evaluated by integrating input from the config and other plugins. The language plugin only reports the fact "this is a type alias" as a `DropHint`; the core makes the final drop decision.

### 10.3 Why fingerprint hashing is excluded from the plugin

Fingerprint consistency ([fingerprint.md](./fingerprint.md) §8) must be guaranteed across languages. SHA-256 / 12-hex truncation / canonical JSON are **implemented in one place in the core**; plugins only return normalized strings.

### 10.4 Why ImportEdge comes from the plugin

Import statement syntax differs greatly per language (TS `import`, Python `from X import Y`, Go `import (...)`). Having the core understand each language's imports directly is too heavy a burden, so it is delegated to the plugin.

### 10.5 Why `extractSymbols` and `walkBody` are separate

Extraction is two-phased:
1. Produce the list of symbol candidates (framework plugins can return extKind hints here)
2. Walk each symbol body (the walk must happen after extKind is decided)

This anticipates cases where, after the framework plugin decides the extKind, walkBody wants to change its behavior based on that information (e.g. treat @Body parameters specially for a NestJS Controller).

### 10.6 Why `normalizeAst` is a separate function

Syntax fingerprint computation is a step independent of IR assembly. normalizeAst is not called for dropped symbols ([fingerprint.md](./fingerprint.md) §6). Separating it explicitly minimizes overhead.
