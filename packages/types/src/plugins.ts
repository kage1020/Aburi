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
  /** false → core skips this file. */
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
   * Local binding for a namespace import (`import * as Foo from './x'` → `"Foo"`).
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
 */
export interface ParseResult<TTree = ParsedTree> {
  tree: TTree | null
  errors: ParseError[]
  imports: ImportEdge[]
}

// --- Symbol candidate (lang plugin output, pre-drop) ---

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
  source: SourceRange
  /** Language-level rationale, e.g. `["export-keyword"]`. */
  derivedBy: string[]
  bodyNode: TNode | null
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
  /** Extension list (not glob), e.g. [".ts", ".tsx"]. */
  fileExtensions: string[]
  capabilities: LanguageCapabilities

  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  parseFile(file: SourceFile): Promise<ParseResult<TTree>>
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

  classifySymbol(
    symbol: SymbolCandidate<TNode>,
    ctx: ExtractionContext,
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
