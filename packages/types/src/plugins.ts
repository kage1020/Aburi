import type { Config } from "./generated/config"
import type {
  ComponentId,
  Confidence,
  Decorator,
  EffectId,
  ExtKind,
  LanguageId,
  Rule,
  Signature,
  SourceRange,
  SymbolId,
  SymbolKind,
  Visibility,
} from "./generated/ir"
import type { PluginManifest } from "./generated/plugin"

export type ParsedTree = unknown
export type OpaqueAstNode = unknown

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
  recoverable: boolean
}

export interface ImportEdge {
  /** Module specifier verbatim (e.g. "@billing/domain", "./util"). */
  source: string
  symbols: string[] | "*"
  line: number
  /** True for `import()` and equivalent dynamic forms. */
  dynamic: boolean
  namespaceBinding?: string
}

/** An `ImportEdge.symbols` entry split into the name the module exports and the local it binds. */
export interface ImportBinding {
  readonly imported: string
  readonly local: string
}

export interface ParseResult<TTree = ParsedTree> {
  tree: TTree | null
  errors: ParseError[]
  imports: ImportEdge[]
}

export type WrittenSourceRange = Omit<SourceRange, "startColumn" | "endColumn"> & {
  startColumn: number | null
  endColumn: number | null
}

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
  mergedDeclarations?: MergedDeclaration<TNode>[]
  fullNode: TNode
}

/** The nodes of one declaration that merged into a Symbol another declaration leads. */
export interface MergedDeclaration<TNode = OpaqueAstNode> {
  bodyNode: TNode | null
  fullNode: TNode
}

export interface CallCandidate {
  target: string
  line: number
  argumentCount: number
  inAwait: boolean
  inNew: boolean
  /** Per-argument literal value, or null when the argument is not a literal. */
  literalArgs: (string | null)[]
  dynamicReceiver?: boolean
}

export interface BodyExtraction {
  rules: Rule[]
  /** Pre-classification call list. */
  calls: CallCandidate[]
}

export interface DropHint {
  /** Goes into Symbol.dropReason verbatim. */
  reason: string
  category: "B" | "C"
}

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

export interface FrameworkClassifyContext extends ExtractionContext {
  imports: readonly ImportEdge[]
}

export type OwnerDecorator = Pick<Decorator, "name" | "qualifier" | "boundary">

export interface OwnerSummary {
  id: SymbolId
  kind: SymbolKind
  name: string
  /** Already populated by framework plugin. */
  extKind: ExtKind
  decorators: OwnerDecorator[]
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

export interface SymbolClassification {
  /** Newly assigned extKind, e.g. `"framework:nestjs:controller"`. */
  extKind?: ExtKind
  decoratorBoundaries?: Record<string, boolean>
  /** Plugin-defined rationale. */
  derivedBy: string
  confidence?: Confidence
}

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

export type LangManifest = PluginManifest & { type: "lang" }
export type EffectsManifest = PluginManifest & { type: "effects" }
export type FrameworkManifest = PluginManifest & { type: "framework" }

export interface LanguagePlugin<TTree = ParsedTree, TNode = OpaqueAstNode> {
  manifest: LangManifest
  languageId: LanguageId
  /** Extension list (not glob), e.g. [".ts", ".tsx"]. */
  fileExtensions: string[]
  capabilities: LanguageCapabilities

  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  parseFile(file: SourceFile): Promise<ParseResult<TTree>>
  releaseTree?(tree: TTree): void
  extractSymbols(tree: TTree, ctx: ExtractionContext): SymbolCandidate<TNode>[]
  walkBody(symbol: SymbolCandidate<TNode>, ctx: WalkContext<TNode>): BodyExtraction
  normalizeAst(symbol: SymbolCandidate<TNode>): string

  /** Language-specific glob list (e.g. `["** /*.d.ts"]`, sans the space). */
  fileDropPatterns?: string[]
  symbolDropHint?(symbol: SymbolCandidate<TNode>, ctx: ExtractionContext): DropHint | null
}

export interface EffectPlugin {
  manifest: EffectsManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null

  /** Drop-list category C additions (logger-style plugins only). */
  dropCallees?: string[]
}

export interface FrameworkPlugin<TNode = OpaqueAstNode> {
  manifest: FrameworkManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classifySymbol(
    symbol: SymbolCandidate<TNode>,
    ctx: FrameworkClassifyContext,
  ): SymbolClassification | null

  symbolDropHint?(symbol: SymbolCandidate<TNode>, ctx: FrameworkClassifyContext): DropHint | null
}

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
