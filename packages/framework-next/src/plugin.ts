import type {
  ExtractionContext,
  FrameworkPlugin,
  OpaqueAstNode,
  PluginContext,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { classifyNextSymbol } from "./classify"
import { frameworkNextManifest } from "./manifest"

class NextFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest: typeof frameworkNextManifest = frameworkNextManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyNextSymbol(symbol, ctx)
  }
}

/** Singleton so `manifest` identity is stable for consumers comparing against the constant. */
export const nextFrameworkPlugin: NextFrameworkPlugin = new NextFrameworkPlugin()

export { NextFrameworkPlugin }
