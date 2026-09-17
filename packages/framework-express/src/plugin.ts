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

/** Pure classifier over module-level Router consts and chained-call registrations; no lazy resources. */
class ExpressFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkExpressManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyExpressSymbol(symbol, ctx)
  }
}

/** Singleton so `manifest` identity is stable for consumers comparing against the constant. */
export const expressFrameworkPlugin = new ExpressFrameworkPlugin()
export { ExpressFrameworkPlugin }
