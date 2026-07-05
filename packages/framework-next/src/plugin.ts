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

/**
 * Next.js framework plugin. Sits between the language plugin's extractSymbols and
 * walkBody, inspecting `SymbolCandidate.source.file` for App Router special files and
 * the surrounding module for `"use client"` / `"use server"` directives.
 *
 * `init` and `classifySymbol` are both pure with respect to plugin state — no lazy
 * resources, no per-run caches — so repeated invocations against the same Symbol
 * produce identical results.
 */
class NextFrameworkPlugin implements FrameworkPlugin<OpaqueAstNode> {
  readonly manifest = frameworkNextManifest

  async init(_ctx: PluginContext): Promise<void> {
    // Intentional no-op — see class-level docstring for the "no lazy resources" rationale.
  }

  classifySymbol(
    symbol: SymbolCandidate<OpaqueAstNode>,
    ctx: ExtractionContext,
  ): SymbolClassification | null {
    return classifyNextSymbol(symbol, ctx)
  }
}

/** Ready-to-register instance. Callers pass this to `@aburi/plugin-registry` or a scan pipeline. */
export const nextFrameworkPlugin: FrameworkPlugin<OpaqueAstNode> = new NextFrameworkPlugin()

export { NextFrameworkPlugin }
