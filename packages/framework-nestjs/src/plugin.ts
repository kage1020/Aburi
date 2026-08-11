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
 * NestJS framework plugin. Sits between the language plugin's extractSymbols and
 * walkBody, inspecting `SymbolCandidate.decorators` and returning a
 * `SymbolClassification` that the framework pipeline folds back into the Symbol.
 *
 * `init` and `classifySymbol` are both pure with respect to plugin state — the classifier
 * is a decorator-table lookup over the Symbol and the file's import edges, with no lazy
 * resources and no cache — so repeated invocations against the same Symbol produce
 * identical results without any reset step.
 */
class NestjsFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkNestjsManifest

  async init(_ctx: PluginContext): Promise<void> {
    // No lazy resources. NestJS classification is a pure decorator-table lookup.
  }

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: FrameworkClassifyContext,
  ): SymbolClassification | null {
    return classifyNestjsSymbol(symbol, ctx)
  }
}

/**
 * Ready-to-register instance. `class implements FrameworkPlugin<OpaqueAstNode>` enforces
 * the structural contract; inferring the narrow class type here keeps the manifest
 * literals visible to consumers that compare against them directly.
 */
export const nestjsFrameworkPlugin = new NestjsFrameworkPlugin()

export { NestjsFrameworkPlugin }
