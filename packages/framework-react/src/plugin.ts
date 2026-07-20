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

/**
 * React framework plugin. Sits between the language plugin's extractSymbols and walkBody,
 * inspecting `SymbolCandidate.name` / `.kind` / `.bodyNode` / `.fullNode` to classify
 * function components, custom hooks, contexts, forwardRef / memo wrappers, providers, and
 * higher-order components.
 *
 * `init` and `classifySymbol` are both pure — no lazy resources, no per-run caches — so
 * repeated invocations against the same Symbol produce identical results.
 */
class ReactFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkReactManifest

  async init(_ctx: PluginContext): Promise<void> {
    // Intentional no-op — see class-level docstring for the "no lazy resources" rationale.
  }

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyReactSymbol(symbol, ctx)
  }
}

/**
 * Ready-to-register instance. `class implements FrameworkPlugin<OpaqueAstNode>` enforces
 * the structural contract; the singleton keeps `manifest` identity stable across
 * consumers that compare against the constant.
 */
export const reactFrameworkPlugin = new ReactFrameworkPlugin()

export { ReactFrameworkPlugin }
