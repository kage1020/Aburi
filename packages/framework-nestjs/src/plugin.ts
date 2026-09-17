import type {
  FrameworkClassifyContext,
  FrameworkPlugin,
  OpaqueAstNode,
  PluginContext,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { classifyNestjsSymbol } from "./classify"
import { frameworkNestjsManifest } from "./manifest"

/**
 * Pure decorator-table lookup over `SymbolCandidate.decorators` and the file's import
 * edges; the only cache (`./classify`) memoizes on the edge array's identity.
 */
class NestjsFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkNestjsManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: FrameworkClassifyContext,
  ): SymbolClassification | null {
    return classifyNestjsSymbol(symbol, ctx)
  }
}

/** Singleton so `manifest` identity is stable for consumers comparing against the constant. */
export const nestjsFrameworkPlugin = new NestjsFrameworkPlugin()

export { NestjsFrameworkPlugin }
