import type {
  BodyExtraction,
  DropHint,
  ExtractionContext,
  LanguageCapabilities,
  LanguagePlugin,
  ParseResult,
  PluginContext,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { classifySymbolDropHint, TYPESCRIPT_FILE_DROP_PATTERNS } from "./drop-hints"
import { extractSymbols } from "./extract-symbols"
import { langTypescriptManifest } from "./manifest"
import { normalizeAst } from "./normalize-ast"
import { parseTypescriptFile } from "./parser"
import { walkBody } from "./walk-body"

/**
 * Language plugin surface described in lang-plugin.md §4.1. Every method delegates to a
 * focused sub-module so the assembly here stays a small binding layer rather than a
 * dumping ground for parser state.
 */
class LangTypescriptPlugin implements LanguagePlugin<Tree, Node> {
  readonly manifest = langTypescriptManifest
  readonly fileExtensions: string[] = [".ts", ".mts", ".cts", ".tsx"]
  readonly capabilities: LanguageCapabilities = {
    hasDecorators: true,
    hasGenerics: true,
    hasAsync: true,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: true,
    hasModules: true,
    hasNamespaces: true,
    hasTypeParameters: true,
    hasExplicitVisibility: true,
    hasJsDoc: true,
  }
  readonly fileDropPatterns: string[] = [...TYPESCRIPT_FILE_DROP_PATTERNS]

  async init(_ctx: PluginContext): Promise<void> {
    // Parser and grammar init happens lazily inside parseFile so init() stays a cheap
    // no-op the pipeline can await unconditionally; the actual WASM setup pays its cost
    // on the first parse.
  }

  async parseFile(file: SourceFile): Promise<ParseResult<Tree>> {
    return parseTypescriptFile(file)
  }

  extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
    return extractSymbols(tree, ctx)
  }

  walkBody(symbol: SymbolCandidate<Node>, ctx: WalkContext<Node>): BodyExtraction {
    return walkBody(symbol, ctx)
  }

  normalizeAst(symbol: SymbolCandidate<Node>): string {
    return normalizeAst(symbol)
  }

  symbolDropHint(symbol: SymbolCandidate<Node>, ctx: ExtractionContext): DropHint | null {
    return classifySymbolDropHint(symbol, ctx)
  }
}

/**
 * Default plugin instance. Callers pass this to `@aburi/plugin-registry` or to a core
 * scan pipeline. Creating instances via `new LangTypescriptPlugin()` is also supported
 * for consumers that want a fresh copy per registry.
 */
export const langTypescriptPlugin: LanguagePlugin<Tree, Node> = new LangTypescriptPlugin()

/** Class export for consumers that want to wrap or extend the plugin. */
export { LangTypescriptPlugin }
