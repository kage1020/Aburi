import type {
  ExtractionContext,
  FrameworkPlugin,
  OpaqueAstNode,
  PluginContext,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { classifyNestjsSymbol } from "./classify"
import { frameworkNestjsManifest } from "./manifest"

/**
 * NestJS framework plugin. Sits between the language plugin's extractSymbols and
 * walkBody, inspecting `SymbolCandidate.decorators` and returning a
 * `SymbolClassification` that the framework pipeline folds back into the Symbol.
 *
 * `init` and `classifySymbol` are both pure with respect to plugin state — the
 * classifier is a decorator-table lookup with no lazy resources — so repeated
 * invocations against the same Symbol produce identical results without any reset
 * step.
 */
class NestjsFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkNestjsManifest

  async init(_ctx: PluginContext): Promise<void> {
    // No lazy resources. NestJS classification is a pure decorator-table lookup.
  }

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyNestjsSymbol(symbol, ctx)
  }
}

/** Ready-to-register instance. Callers pass this to `@aburi/plugin-registry` or a scan pipeline. */
export const nestjsFrameworkPlugin: FrameworkPlugin<OpaqueAstNode> = new NestjsFrameworkPlugin()

export { NestjsFrameworkPlugin }
