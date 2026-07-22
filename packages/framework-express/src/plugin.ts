import type {
  ExtractionContext,
  FrameworkPlugin,
  OpaqueAstNode,
  PluginContext,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { classifyExpressSymbol } from "./classify"
import { frameworkExpressManifest } from "./manifest"

class ExpressFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkExpressManifest

  async init(_ctx: PluginContext): Promise<void> {
    // Intentional no-op — pure classifier, no lazy resources.
  }

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyExpressSymbol(symbol, ctx)
  }
}

export const expressFrameworkPlugin = new ExpressFrameworkPlugin()
export { ExpressFrameworkPlugin }
