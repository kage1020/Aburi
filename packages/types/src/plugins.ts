// Hand-written plugin interface signatures. Source: design/details/lang-plugin.md,
// effect-plugin.md, and extension-vocab.md. These complement the schema-generated
// types in src/generated/ and form the contract between @aburi/core and individual
// language / effects / framework plugins.

import type { Config } from "./generated/config"
import type {
  Decorator,
  EffectId,
  ExtKind,
  Signature,
  SourceRange,
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
  /** Named imports, or "*" for namespace / wildcard. */
  symbols: string[] | "*"
  line: number
  /** True for `import()` and equivalent dynamic forms. */
  dynamic: boolean
}

export interface ParseResult {
  tree: ParsedTree
  errors: ParseError[]
  imports: ImportEdge[]
}

// --- Symbol candidate (lang plugin output, pre-drop) ---

export interface SymbolCandidate {
  /** Format: `<language>:<file>#<qname>`. */
  id: string
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
  bodyNode: OpaqueAstNode | null
  fullNode: OpaqueAstNode
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

export interface WalkContext extends ExtractionContext {
  symbol: SymbolCandidate
}

// --- Effect classification context ---

export interface OwnerSummary {
  id: string
  kind: SymbolKind
  name: string
  /** Already populated by framework plugin (lang-plugin.md §5.3). */
  extKind: ExtKind
  decorators: { name: string; boundary: boolean }[]
  component: string | null
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
 * Language plugin. Owns parsing and Symbol candidate extraction for a single
 * `language` id. See design/details/lang-plugin.md.
 */
export interface LanguagePlugin {
  /** Must have type: "lang". */
  manifest: PluginManifest
  /** Extension list (not glob), e.g. [".ts", ".tsx"]. */
  fileExtensions: string[]
  capabilities: LanguageCapabilities

  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  parseFile(file: SourceFile): Promise<ParseResult>
  extractSymbols(tree: ParsedTree, ctx: ExtractionContext): SymbolCandidate[]
  walkBody(symbol: SymbolCandidate, ctx: WalkContext): BodyExtraction
  normalizeAst(symbol: SymbolCandidate): string

  /** Language-specific glob list (e.g. `["** /*.d.ts"]`, sans the space). */
  fileDropPatterns?: string[]
  symbolDropHint?(symbol: SymbolCandidate, ctx: ExtractionContext): DropHint | null
}

/**
 * Effect plugin. Classifies a CallCandidate into a semantic effect. Pure-function
 * shape is strongly preferred. See design/details/effect-plugin.md.
 */
export interface EffectPlugin {
  /** Must have type: "effects". */
  manifest: PluginManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null

  /** Optional: drop-list category C additions (logger-style plugins only). */
  dropCallees?: string[]
}

/**
 * Framework plugin. Adjusts SymbolCandidate extKind / decorator boundaries based
 * on framework conventions. Runs between extractSymbols and walkBody.
 * See design/details/lang-plugin.md §5.2 and extension-vocab.md §3.
 */
export interface FrameworkPlugin {
  /** Must have type: "framework". */
  manifest: PluginManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classifySymbol(symbol: SymbolCandidate, ctx: ExtractionContext): SymbolClassification | null
}

// --- Vocab registry (implemented by @aburi/plugin-registry, consumed by plugins) ---

export interface EffectVocab {
  id: EffectId
  description: string | null
  owner: PluginManifest
}

export interface ExtKindVocab {
  id: string
  baseKind: SymbolKind
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
