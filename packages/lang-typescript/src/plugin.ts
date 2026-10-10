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
import { parseTypescriptFile, TYPESCRIPT_FILE_EXTENSIONS } from "./parser"
import { TYPESCRIPT_LANGUAGE_ID } from "./qname"
import { walkBody } from "./walk-body"

class LangTypescriptPlugin implements LanguagePlugin<Tree, Node> {
  readonly manifest = langTypescriptManifest
  readonly languageId = TYPESCRIPT_LANGUAGE_ID
  readonly fileExtensions: string[] = [...TYPESCRIPT_FILE_EXTENSIONS]
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
  }

  async parseFile(file: SourceFile): Promise<ParseResult<Tree>> {
    return parseTypescriptFile(file)
  }

  releaseTree(tree: Tree): void {
    tree.delete()
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

export const langTypescriptPlugin = new LangTypescriptPlugin() satisfies LanguagePlugin<Tree, Node>

/** Class export for consumers that want to wrap or extend the plugin. */
export { LangTypescriptPlugin }
