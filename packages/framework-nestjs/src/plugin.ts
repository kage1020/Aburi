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
 * NestJS framework plugin. Implements the FrameworkPlugin contract described in
 * design/details/lang-plugin.md §5.2 — sits between the language plugin's extractSymbols
 * and walkBody, inspecting SymbolCandidate.decorators and returning a
 * SymbolClassification that core folds back into the SymbolCandidate.
 *
 * Idempotency: init() and classifySymbol() are pure with respect to plugin state, so
 * repeated invocations against the same Symbol produce the same result. The framework
 * pipeline reruns `classifySymbol` after config reloads without needing a reset.
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

/** Default plugin instance. Callers pass this to `@aburi/plugin-registry` or the core scan pipeline. */
export const nestjsFrameworkPlugin: FrameworkPlugin<OpaqueAstNode> = new NestjsFrameworkPlugin()

/** Class export for consumers that want to wrap or extend the plugin. */
export { NestjsFrameworkPlugin }
