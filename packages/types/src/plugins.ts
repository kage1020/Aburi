// Hand-written plugin interface signatures. Source: docs/design/lang-plugin.md,
// effect-plugin.md, and extension-vocab.md. These complement the schema-generated
// types in src/generated/ and form the contract between @aburi/core and individual
// language / effects / framework plugins.

import type { Config } from "./generated/config"
import type {
  ComponentId,
  Confidence,
  Decorator,
  EffectId,
  ExtKind,
  LanguageId,
  Signature,
  SourceRange,
  SymbolId,
  SymbolKind,
  Visibility,
} from "./generated/ir"
import type { PluginManifest } from "./generated/plugin"

// --- Opaque AST handles ---
// Each lang plugin owns its concrete parser type. Core never inspects the inside;
// it only hands the value back to the plugin in walkBody / normalizeAst.
export type ParsedTree = unknown
export type OpaqueAstNode = unknown

// --- Source input / parse output ---

/** Workspace-relative POSIX path + UTF-8 source. */
export interface SourceFile {
  path: string
  content: string
}

export interface ParseError {
  message: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
  /**
   * `false` withdraws the file: no Symbols, no `stats.parsedFiles`, an entry in
   * `ScanResult.skipped` under `reason: "parse-failed"` quoting this message, and a warning.
   *
   * Independent of `tree`. A plugin that built a usable tree and then decided the file must
   * not be used — a wrong-dialect source, a generated blob — says so here rather than
   * discarding the tree to be heard, and one that could not build a tree at all sets both.
   */
  recoverable: boolean
}

/**
 * Single import edge as observed in the source. Language-specific syntax is
 * already normalized away by the plugin.
 */
export interface ImportEdge {
  /** Module specifier verbatim (e.g. "@billing/domain", "./util"). */
  source: string
  /**
   * Named imports, or "*" for namespace / wildcard.
   *
   * For aliased named imports (`import { X as Y }`) the entry is the string
   * `"X as Y"` — the exported name paired with the local rebind separated by
   * ` as `. Callers that only care about the exported name split on the
   * separator; callers that need the local binding (call resolution) do the
   * same split and pick the right half. Un-aliased imports emit the plain
   * exported name (`"X"`).
   */
  symbols: string[] | "*"
  line: number
  /** True for `import()` and equivalent dynamic forms. */
  dynamic: boolean
  /**
   * Local name bound to the module as a whole — `import * as Foo from './x'` and
   * `import Foo = require('./x')` both give `"Foo"`, because both make `Foo` the
   * module object rather than one of its exports.
   *
   * Present only on edges whose `symbols` is `"*"`. Absent on bare side-effect
   * imports (`import './x'`) and on wildcard re-exports (`export * from './x'`)
   * where there is no in-scope binding for the caller to reference.
   */
  namespaceBinding?: string
}

/**
 * `TTree` defaults to the opaque `ParsedTree`. Lang plugins should specialize it
 * to their own parser type so cross-plugin tree leaks are caught at compile time
 * (e.g. handing a tree-sitter `Tree` to a SWC-based plugin's walkBody).
 */
/**
 * `tree` is nullable so a plugin can report a genuinely unrecoverable parse (e.g. the
 * underlying parser returned null) without fabricating a fake tree that would violate the
 * plugin's own tree type. Callers must check `tree === null` before dispatching to
 * extractSymbols / walkBody / normalizeAst; the paired `errors[]` is expected to carry a
 * `recoverable: false` entry when that happens.
 *
 * A non-null `tree` is handed over: the plugin stops owning it here, and the caller owes it
 * one `releaseTree` once the last of extractSymbols / walkBody / normalizeAst has run. A
 * plugin that freed it on its own way out would be handing back a dead handle.
 */
export interface ParseResult<TTree = ParsedTree> {
  tree: TTree | null
  errors: ParseError[]
  imports: ImportEdge[]
}

// --- Symbol candidate (lang plugin output, pre-drop) ---

/**
 * A `SourceRange` as a writer must produce it: both column keys are always present,
 * carrying `null` when the position is unknown (`ir-schema.md` §1.1 Class A, §12).
 *
 * The read-side `SourceRange` keeps them optional on purpose, and the asymmetry is the
 * point — writers are held to the convention, readers stay tolerant of documents that
 * predate it. An IR loaded off disk may legitimately omit the keys, so narrowing the
 * generated type would make a valid v1 document unrepresentable; narrowing only the
 * plugin's output type costs nothing, because a plugin builds every `SourceRange` it
 * emits from scratch.
 *
 * The narrowed type is assignable to `SourceRange`, so nothing downstream of the plugin
 * boundary has to know about it.
 */
export type WrittenSourceRange = Omit<SourceRange, "startColumn" | "endColumn"> & {
  startColumn: number | null
  endColumn: number | null
}

/**
 * `TNode` defaults to the opaque `OpaqueAstNode`. Lang plugins should specialize it
 * to their own AST node type so a SymbolCandidate from plugin A cannot be fed into
 * plugin B's walkBody.
 */
export interface SymbolCandidate<TNode = OpaqueAstNode> {
  /** Format: `<language>:<file>#<qname>`. Build it with `makeSymbolId` from `@aburi/core`. */
  id: SymbolId
  kind: SymbolKind
  extKind: ExtKind
  /** Qualified name. */
  name: string
  visibility: Visibility
  decorators: Decorator[]
  signature: Signature | null
  source: WrittenSourceRange
  /** Language-level rationale, e.g. `["export-keyword"]`. */
  derivedBy: string[]
  bodyNode: TNode | null
  /**
   * Bodies of the further declarations that merged into this Symbol, in source order.
   *
   * One entity can be written as several declarations — a getter beside its setter, an
   * overload beside its implementation, an interface reopened, a namespace augmenting the
   * class it follows. All of those are one Symbol, and `bodyNode` is the one the Symbol's
   * scalars come from; the rest arrive here so that `walkBody` and `normalizeAst` see the
   * whole entity rather than the declaration that happened to be written first.
   *
   * Absent means the Symbol has one declaration, which is the ordinary case — a consumer
   * that reads only `bodyNode` is then complete, and every path that was correct before the
   * field existed still is.
   */
  mergedBodyNodes?: TNode[]
  fullNode: TNode
}

// --- Body walk output ---

/**
 * A raw call_expression with the minimum information needed for effect
 * classification. AST access is intentionally not exposed.
 */
export interface CallCandidate {
  /** Callee as a normalized string (e.g. `prisma.invoice.create`). */
  target: string
  line: number
  argumentCount: number
  /** True if the call is under `await`. */
  inAwait: boolean
  /** True if the call is a `new` expression. */
  inNew: boolean
  /** Per-argument literal value, or null when the argument is not a literal. */
  literalArgs: (string | null)[]
  /**
   * True when the callee's receiver was an expression rather than a name —
   * `getRepo().save()`, `items[0].save()`, `(a ?? b).save()`. Normalization
   * collapses such a receiver to whatever name it can find (`getRepo.save`),
   * which is indistinguishable from a genuine qualified name once the AST is
   * gone. The flag preserves the distinction so call resolution can report the
   * `dynamic` diagnostic bucket of `call-resolution.md` §8.1 instead of
   * misfiling the call under `no-match`. Absent means false.
   */
  dynamicReceiver?: boolean
}

export interface BodyExtraction {
  /** Rules per ir-schema §8. */
  rules: import("./generated/ir").Rule[]
  /** Pre-classification call list. */
  calls: CallCandidate[]
}

// --- Drop hint ---

export interface DropHint {
  /** Goes into Symbol.dropReason verbatim. */
  reason: string
  /** drop-list §2 category. */
  category: "B" | "C"
}

// --- Logger / plugin context ---

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface PluginContext {
  registry: VocabRegistry
  config: Config
  /** Absolute path used by plugins to set up parsers. */
  workspaceRoot: string
  log: Logger
}

export interface ExtractionContext {
  file: SourceFile
  registry: VocabRegistry
  config: Config
}

export interface WalkContext<TNode = OpaqueAstNode> extends ExtractionContext {
  symbol: SymbolCandidate<TNode>
}

/**
 * What a framework plugin classifies against: the extraction context plus the file's own
 * import edges.
 *
 * The edges are what let a decorator-driven plugin resolve `import { Controller as Ctrl }`
 * back to `Controller`, and tell a `@Controller` that came from the framework's own package
 * apart from one that came from a competing library. Matching on the written identifier
 * alone gets both wrong in opposite directions — it misses the alias and it claims the
 * stranger.
 *
 * `imports` is the same list `ParseResult.imports` produced for the file, normalized. That
 * includes re-export edges (`export { X } from './y'`), which name a symbol without binding
 * it locally; a plugin reading the list is asking "what does this file say about this
 * name", not "what is lexically in scope".
 *
 * Effect plugins get the same information through `ClassifyContext.file.imports`.
 *
 * `readonly` because the pipeline hands over the live array rather than a copy: the same
 * instance is what it reports as the file's imports and what call resolution reads. A plugin
 * that sorted or spliced it would rewrite the IR from inside a classifier. The element
 * objects are still shared, which the type cannot express without a deep-readonly `ImportEdge`
 * that every language plugin would then have to build around.
 */
export interface FrameworkClassifyContext extends ExtractionContext {
  imports: readonly ImportEdge[]
}

// --- Effect classification context ---

export interface OwnerSummary {
  id: SymbolId
  kind: SymbolKind
  name: string
  /** Already populated by framework plugin (lang-plugin.md §5.3). */
  extKind: ExtKind
  decorators: { name: string; boundary: boolean }[]
  component: ComponentId | null
}

export interface FileSummary {
  path: string
  imports: ImportEdge[]
}

export interface ClassifyContext {
  owner: OwnerSummary
  file: FileSummary
  /** ISO language id from manifest, e.g. "ts" / "py" / "rs". */
  language: string
  registry: VocabRegistry
  config: Config
}

export interface EffectClassification {
  /** Core EffectId or `x-<plugin>:<action>`. */
  effectId: EffectId
  confidence: "high" | "medium" | "low"
  /** Plugin-defined rationale, e.g. `"effects-plugin:prisma:read"`. */
  derivedBy: string
}

// --- Framework symbol classification ---

export interface SymbolClassification {
  /** Newly assigned extKind, e.g. `"framework:nestjs:controller"`. */
  extKind?: ExtKind
  /**
   * Decorator name → boundary flag overrides applied to SymbolCandidate.decorators
   * after framework classification.
   */
  decoratorBoundaries?: Record<string, boolean>
  /** Plugin-defined rationale. */
  derivedBy: string
  /**
   * Optional signal strength. Omit ⇒ implicit "high" (the current behavior of
   * decorator-based and syntactic wrapper-based classifiers). Framework plugins that
   * pattern-match on ambiguous shapes (e.g. an Express `app.use(fn)` without a same-file
   * `const app = express()` anchor) should downgrade to "medium".
   */
  confidence?: Confidence
}

// --- Language capabilities ---

export interface LanguageCapabilities {
  hasDecorators: boolean
  hasGenerics: boolean
  hasAsync: boolean
  hasMacros: boolean
  hasPatternMatching: boolean
  /** abstract class / trait / interface. */
  hasAbstractTypes: boolean
  /** ES module / Python module / Go package. */
  hasModules: boolean
  /** TS namespace / C# namespace. */
  hasNamespaces: boolean
  hasTypeParameters: boolean
  /** public/private keyword. */
  hasExplicitVisibility: boolean
  /** JSDoc / docstring / etc. */
  hasJsDoc: boolean
}

// --- Plugin interfaces ---

/**
 * Manifest narrowed to a specific plugin type. Each plugin interface uses the
 * matching narrow so an `effects` manifest cannot be assigned to a LanguagePlugin
 * etc.
 */
export type LangManifest = PluginManifest & { type: "lang" }
export type EffectsManifest = PluginManifest & { type: "effects" }
export type FrameworkManifest = PluginManifest & { type: "framework" }

/**
 * Language plugin. Owns parsing and Symbol candidate extraction for a single
 * `language` id. See docs/design/lang-plugin.md.
 *
 * Specialize `TTree` / `TNode` to the plugin's own parser types so a tree
 * produced by plugin A cannot be fed into plugin B's walkBody.
 */
export interface LanguagePlugin<TTree = ParsedTree, TNode = OpaqueAstNode> {
  manifest: LangManifest
  /**
   * The `LanguageId` this plugin owns — the segment before the colon in every Symbol id
   * it produces (`ts:src/a.ts#alpha` ⇒ `"ts"`), and the value `@aburi/core` projects into
   * `IR.workspace.languages`.
   *
   * This is deliberately *not* `manifest.name`: the manifest name is a plugin ref
   * (`lang-typescript`, kebab-case, resolved as a module specifier) while `LanguageId` is
   * constrained to `^[a-z][a-z0-9]*$` by `aburi.ir.v1`. A plugin whose manifest name were
   * used here would emit an IR that fails its own frozen schema.
   *
   * One token per plugin, not one per `fileExtensions` entry: a plugin that parses a family
   * of dialects reports the family. `@aburi/lang-typescript` claims `.ts` / `.tsx` / `.js` /
   * `.jsx` and reports `ts` for all of them, so the component detector's finer per-extension
   * vocabulary (`tsx`, `js`, `jsx`) and this one can legitimately disagree within a document.
   */
  languageId: LanguageId
  /** Extension list (not glob), e.g. [".ts", ".tsx"]. */
  fileExtensions: string[]
  capabilities: LanguageCapabilities

  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  parseFile(file: SourceFile): Promise<ParseResult<TTree>>
  /**
   * Free the tree `parseFile` handed over. Called exactly once per non-null tree, as soon as
   * the core is done reading it: after the last of extractSymbols / walkBody / normalizeAst
   * *that ran*, or immediately, on the paths where none of them did — a file the plugin
   * withdrew with a `recoverable: false` error, and one that was already over its parse
   * budget. A stage that threw is one of the paths, not an exception to them. A plugin whose
   * trees are ordinary garbage-collected objects omits the method.
   *
   * This is where the WASM convention in docs/design/lang-plugin.md §8.1 is discharged for
   * the tree: the plugin can free its parser inside `parseFile`, but not the tree, which by
   * then belongs to the caller. Implementations need not be idempotent or defensive — one
   * call, on a live handle, is what they are given.
   *
   * **Synchronous.** It is called from a `finally` on paths that are already unwinding an
   * exception, where awaiting would let a slow release delay a failure the caller is trying
   * to report — so the return value is ignored and never awaited. A void-returning method
   * type accepts an `async` implementation, and one is a contract violation: its rejection
   * would escape the caller's guard entirely and surface as an unhandled rejection, which is
   * the one case where "a throw is recorded and dropped" does not hold.
   *
   * A throw is recorded against the plugin and dropped, rather than replacing whatever the
   * file was already doing. Declaring this as anything other than a function is recorded too,
   * and said in different words: it is a contract violation, not a parser fault.
   */
  releaseTree?(tree: TTree): void
  extractSymbols(tree: TTree, ctx: ExtractionContext): SymbolCandidate<TNode>[]
  walkBody(symbol: SymbolCandidate<TNode>, ctx: WalkContext<TNode>): BodyExtraction
  normalizeAst(symbol: SymbolCandidate<TNode>): string

  /** Language-specific glob list (e.g. `["** /*.d.ts"]`, sans the space). */
  fileDropPatterns?: string[]
  symbolDropHint?(symbol: SymbolCandidate<TNode>, ctx: ExtractionContext): DropHint | null
}

/**
 * Effect plugin. Classifies a CallCandidate into a semantic effect. Pure-function
 * shape is strongly preferred. See docs/design/effect-plugin.md.
 */
export interface EffectPlugin {
  manifest: EffectsManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null

  /** Optional: drop-list category C additions (logger-style plugins only). */
  dropCallees?: string[]
}

/**
 * Framework plugin. Adjusts SymbolCandidate extKind / decorator boundaries based
 * on framework conventions. Runs between extractSymbols and walkBody.
 * See docs/design/lang-plugin.md §5.2 and extension-vocab.md §3.
 *
 * `TNode` mirrors the lang plugin's AST node type so a framework plugin paired
 * with a specific lang plugin sees the right tree.
 */
export interface FrameworkPlugin<TNode = OpaqueAstNode> {
  manifest: FrameworkManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  /**
   * `ctx` widened from `ExtractionContext` to carry the file's import edges. A plugin that
   * has no use for them may still declare the parameter as the supertype `ExtractionContext`
   * and satisfy this interface.
   */
  classifySymbol(
    symbol: SymbolCandidate<TNode>,
    ctx: FrameworkClassifyContext,
  ): SymbolClassification | null
}

// --- Vocab registry (implemented by @aburi/plugin-registry, consumed by plugins) ---

/**
 * `description` / `baseKind` are `null` for ids that the registry resolves through
 * prefix ownership only — the owning plugin declared `effectPrefixes` /
 * `extKindPrefixes` but did not enumerate the specific id. Non-null when the id
 * appears in the plugin manifest's `effects[]` / `extKinds[]` individually.
 */
export interface EffectVocab {
  id: EffectId
  description: string | null
  owner: PluginManifest
}

export interface ExtKindVocab {
  id: string
  baseKind: SymbolKind | null
  description: string | null
  owner: PluginManifest
}

export interface FrameworkVocab {
  name: string
  owner: PluginManifest
}

/**
 * Registry API surfaced to plugins via PluginContext / *Context. The runtime
 * implementation lives in @aburi/plugin-registry; this interface is the contract.
 */
export interface VocabRegistry {
  findEffect(id: string): EffectVocab | null
  findExtKind(id: string): ExtKindVocab | null
  findFramework(name: string): FrameworkVocab | null
  findDerivedByOwner(value: string): PluginManifest | null

  isEffectOwnedBy(id: string, pluginName: string): boolean
  isExtKindOwnedBy(id: string, pluginName: string): boolean

  listEffects(): EffectVocab[]
  listExtKinds(): ExtKindVocab[]
  listFrameworks(): FrameworkVocab[]
  listPlugins(): PluginManifest[]

  /** Throws if `id` is not owned by `byPlugin` (or its prefixes). */
  assertEffectDeclared(id: string, byPlugin: string): void
  /** Throws if `id` is not owned by `byPlugin` (or its prefixes). */
  assertExtKindDeclared(id: string, byPlugin: string): void
}
