import type {
  ExtractionContext,
  FrameworkPlugin,
  OpaqueAstNode,
  PluginContext,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { classifyReactSymbol } from "./classify"
import { frameworkReactManifest } from "./manifest"

/** Pure classifier over `SymbolCandidate` name / kind / body / fullNode; no lazy resources. */
class ReactFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkReactManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyReactSymbol(symbol, ctx)
  }
}

/** Singleton so `manifest` identity is stable for consumers comparing against the constant. */
export const reactFrameworkPlugin = new ReactFrameworkPlugin()

export { ReactFrameworkPlugin }
