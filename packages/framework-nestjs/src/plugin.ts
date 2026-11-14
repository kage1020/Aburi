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

class NestjsFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest: typeof frameworkNestjsManifest = frameworkNestjsManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: FrameworkClassifyContext,
  ): SymbolClassification | null {
    return classifyNestjsSymbol(symbol, ctx)
  }
}

/** Singleton so `manifest` identity is stable for consumers comparing against the constant. */
export const nestjsFrameworkPlugin: NestjsFrameworkPlugin = new NestjsFrameworkPlugin()

export { NestjsFrameworkPlugin }
