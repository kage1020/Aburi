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
  /**
   * What the importing module exports from the edge's module: a named or namespace re-export
   * (`export { A as B } from`, `export * as ns from`), or an import that an export clause or
   * `export default` republishes. `symbols` cannot say it: a re-export binds no local, and an
   * import says nothing of what the module exports. Absent when the module republishes nothing
   * from the edge; `export * from` names nothing, so it adds no entry.
   */
  reexports?: readonly Reexport[]
  /**
   * Set by the scan, never by the language plugin, and only for a name a decorator in the file
   * binds while a framework plugin is loaded. Keyed by that name as the edge's module exports it,
   * the first bare specifier the module's `reexports` lead to that no workspace file answers, which
   * may be a workspace package the package manager links. A name without a key may be declared
   * anywhere: in the workspace, or behind a re-export the scan could not follow.
   */
  origins?: ReadonlyMap<string, string>
}

/** An `ImportEdge.symbols` entry split into the name the module exports and the local it binds. */
export interface ImportBinding {
  readonly imported: string
  readonly local: string
}

/** A name a module exports that it takes from an import edge's module. */
export interface Reexport {
  /** The name the edge's module exports, or `*` for the whole module as a namespace. */
  readonly imported: string
  /** The name the importing module exports it under. */
  readonly exported: string
}

export interface ParseResult<TTree = ParsedTree> {
  tree: TTree | null
  errors: ParseError[]
  /** `origins` is the scan's to write; the scan drops any a plugin returns. */
  imports: Omit<ImportEdge, "origins">[]
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
  /** The named type the receiver is declared with, type arguments aside, e.g. `EventEmitter2`. */
  receiverType?: string
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

export interface ImportResolverContext {
  /** Absolute. */
  workspaceRoot: string
  log: Logger
}

/** One scan's view of the build config a language reads its non-relative specifiers through. */
export interface ImportResolver {
  /**
   * The workspace-relative POSIX paths `specifier`, written in `fromFile`, maps to, in the order
   * the language tries them. The core probes each as it probes a relative specifier, so a path may
   * leave out the extension or name a directory.
   */
  resolve(specifier: string, fromFile: string): Promise<readonly string[]>
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

/**
 * `classify`'s answer for a call whose shape the plugin recognises and leaves unclassified on
 * purpose, so the IR can say why the call stayed in `calls[]`.
 */
export interface EffectDecline {
  /** Plugin-defined reason, e.g. `"effects-plugin:trpc:server-file-query"`. */
  declined: string
}

export interface SymbolClassification {
  /** Newly assigned extKind, e.g. `"framework:nestjs:controller"`. */
  extKind?: ExtKind
  decoratorBoundaries?: Record<string, boolean>
  /** Plugin-defined rationale. */
  derivedBy: string
  confidence?: Confidence
  /** The middleware the registration hands its handler to, in the order they run. */
  middleware?: readonly string[]
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

  /** Called at most once per scan; the resolver may cache what it reads for that scan's length. */
  createImportResolver?(ctx: ImportResolverContext): ImportResolver
}

export interface EffectPlugin {
  manifest: EffectsManifest
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null

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
