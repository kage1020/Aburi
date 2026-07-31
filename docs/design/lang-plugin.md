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
4. After all files, plugin.cleanup?() is called
```

The core then performs effect classification, drop-list application, and fingerprint computation.

## 4. Interface

The actual types are defined in the `types` package of `@aburi/core`. This document shows the signatures as a contract.

### 4.1 `LanguagePlugin`

```ts
interface LanguagePlugin {
  manifest: PluginManifest                     // type: "lang"

  // file matching (extensions only, not globs)
  fileExtensions: string[]                     // e.g. [".ts", ".tsx", ".mts", ".cts"]

  // capabilities (§6)
  capabilities: LanguageCapabilities

  // lifecycle
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // extraction
  parseFile(file: SourceFile): Promise<ParseResult>
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
  tree: ParsedTree                             // plugin-internal type (opaque)
  errors: ParseError[]
  imports: ImportEdge[]
}

interface ParseError {
  message: string
  line: number                                 // 1-based
  column: number                               // 1-based
  recoverable: boolean                         // false → the core skips this file
}

interface ImportEdge {
  source: string                               // verbatim string (e.g. "@billing/domain", "./util")
  symbols: string[] | '*'                      // named-import symbol names, or "*"
  line: number
  dynamic: boolean                             // true for import()
}
```

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
  source: SourceRange
  derivedBy: string[]                          // language-level evidence (e.g. ["export-keyword"])

  // internal handles passed to walkBody / normalizeAst
  bodyNode: OpaqueAstNode | null
  fullNode: OpaqueAstNode                      // signature + body
}
```

`id` is a `SymbolId`, not a `string`: the type is nominal ([ir-schema.md](./ir-schema.md) §3.5), so a plugin cannot hand core an id it assembled by concatenation. Build it with `makeSymbolId` from `@aburi/core`, which enforces the §3.1 grammar — a lowercase-ASCII language token that is not reserved, a POSIX workspace-relative path, and an identifier-like qualified name — and throws a coded `CoreError` otherwise. `trySymbolId` is the non-throwing variant, for a plugin that assembles speculative ids and expects some of them not to be buildable.

A brand can be asserted rather than constructed, so the type is a contract, not a lock. Do not take that route: a plugin whose qualified names the §3.2 grammar cannot express — Ruby's `save!` and `valid?` are the standing example — must **widen the grammar**, not cast around it. The call-graph resolver and the LSP enrichment tier build candidate ids through `trySymbolId` and treat a refusal as "no such callee", so an id the constructor would have rejected resolves against nothing while looking like an ordinary miss. `assertIRIntegrity` catches it at the end of the scan (§14 invariant #17) and names the offending id, so it surfaces as a failure rather than as silently thinner output — but the diagnostic bucket in [call-resolution.md](./call-resolution.md) §8.1 has no way to say "the grammar refused this candidate", so the reason will not appear in `stats.callResolution`.

When the plugin chooses an `extKind` from its own declarations, the chosen value must fall under manifest.provides.extKinds or extKindPrefixes. The registry detects violations at startup.

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

#### `dynamicReceiver`

Set it to `true` when the callee's receiver was an **expression rather than a name** — `getRepo().save()`, `items[0].save()`, `(a ?? b).save()`. Leave it absent otherwise; absent means `false`, so existing plugins stay valid without a change.

Normalization is lossy here in a way only the plugin can repair: `getRepo().save()` collapses to the target `getRepo.save`, which is spelled exactly like a genuine `Class.method` qname. Without the flag, [`call-resolution.md`](./call-resolution.md) §8.1 would have to file every such call under `no-match` and send reviewers hunting for a typo that does not exist; with it, the call is correctly reported as `dynamic`.

Do **not** set it for `this.save()` / `super.save()` — §4.7 already keeps those unresolved through a separate rule, and the resolver buckets them itself. Be conservative: a receiver shape the plugin does not model (a non-null assertion, a type assertion) is not evidence of dynamic dispatch, and over-reporting would make the bucket useless. The flag never affects which calls resolve — it only decides which diagnostic bucket an already-unresolved call lands in.

### 4.5 `ExtractionContext` / `WalkContext`

```ts
interface ExtractionContext {
  file: SourceFile
  registry: VocabRegistry                      // ext-vocab §7
  config: AburiConfig
}

interface WalkContext extends ExtractionContext {
  symbol: SymbolCandidate
}
```

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
- the framework declaration of the owning component

Against these it may:
- override `decorator.boundary`
- fill in `Symbol.extKind` (e.g. `framework:nestjs:controller`)
- provide a Category B drop exclusion hint (e.g. a class carrying only `@Module` must not be treated as a pure DTO)

The detailed interface is deferred to a future `framework-plugin.md` (this document only reserves the contract surface).

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
core applies the drop list / computes fingerprints / assembles the IR
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
- `recoverable: false` → the file is skipped, excluded from stats.parsedFiles, warning log

### 7.1.1 Large-file skip

Files whose size exceeds `config.maxFileSizeBytes` (default: `2 * 1024 * 1024` = 2MB) are skipped without parsing.

- Normal code does not exceed 2MB (only generated bundles / minified files do)
- Large files exhaust the WASM heap and make parse time explode
- Skipped files will be recorded in `stats.skippedFiles[]` (planned — see the [roadmap](../roadmap.md)); currently only a warning is emitted
- warning stderr: `Skipped <file>: <size>MB exceeds maxFileSizeBytes (2MB). Override with config.maxFileSizeBytes.`

### 7.1.2 Timeout

If the total of parse + extractSymbols + walkBody for one file exceeds `config.parseTimeoutMs` (default: `5000` = 5 seconds), abort, skip that file, and warn.
This prevents a broken grammar or pathological source (deep nesting, etc.) from stalling the whole run.

### 7.2 Extraction exceptions

- If `extractSymbols` / `walkBody` / `normalizeAst` throws → skip the entire file, warning log
- The extraction pipeline as a whole does not stop (prevents one file's bug from halting all IR generation)
- However, the `--strict` flag enables "stop at the first error"

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

1. **Create and release the parser instance per file**
   - Create the parser inside `parseFile()` and call `parser.delete()` after obtaining the result
   - Also release the file-scoped `tree` via `tree.delete()`
   - Intermediate node references used by `extractSymbols()` / `walkBody()` must be confined to the scope of `parseFile()`
2. **WASM heap budget under parallel execution**
   - `capabilities.wasmHeapPerWorkerMB` in the plugin manifest (range: 16–4096 MiB, implicit default 256 MiB when undeclared) is the source-of-truth
   - The core caps `--concurrency` at `min(specified value, floor(availableMemoryMB / wasmHeapPerWorkerMB))`
   - When multiple lang plugins coexist in the same run, the **maximum** of each plugin's declared value is used (sized for the hungriest lang)
3. **Reservation for a native-binding fallback**
   - In a future release, switching to native bindings (e.g. the `tree-sitter` Node bindings) may be added via flags such as `capabilities.preferNative` (see the [roadmap](../roadmap.md))
   - Currently only WASM is implemented; no native fallback is provided

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
| LP8 | nested class (`Outer.Inner.method`) | the `.` nesting in name is correct |

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
| LP15 | two decorators | 2 entries in decorators[], ascending by line |

### 9.4 Body walk

| ID | Input | Expected |
|---|---|---|
| LP16 | `if (x) throw new E()` | guard + throw in rules |
| LP17 | `return 1` | no return in rules (trivial) |
| LP18 | `return foo()` | no return in rules, foo in calls |
| LP19 | `return a + b` | return in rules (expr: "a + b") |
| LP20 | `for (let i...) ...` | loop in rules (loopKind: "for") |

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

### 9.7 Error recovery

| ID | Input | Expected |
|---|---|---|
| LP27 | file containing a syntax error | returns a recoverable error, extracts Symbols where possible |
| LP28 | completely broken file | returns a non-recoverable error, the core skips it |

### 9.8 Symbol id construction

| ID | Input | Expected |
|---|---|---|
| LP29 | Any extracted Symbol | `SymbolCandidate.id` came from `makeSymbolId`; a hand-assembled `` `${lang}:${file}#${qname}` `` does not type-check against `SymbolId` (§4.3) |
| LP30 | A qualified name the §3.2 grammar rejects (empty, anonymous marker, non-identifier segment) | `makeSymbolId` throws a coded `CoreError`; the id never reaches the IR |

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
