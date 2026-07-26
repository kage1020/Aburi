import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyTrpcCall } from "./classify"
import { effectsTrpcManifest } from "./manifest"

/**
 * tRPC effect plugin. Maps tRPC client procedure calls onto the core `network.rpc` effect
 * vocabulary, recording the router-relative procedure path in `derivedBy`. See
 * `classifyTrpcCall` for the detection strategy (client import gate + three-segment
 * minimum + `query`-terminal suppression in router files).
 *
 * Pure with respect to plugin state — no lazy resources, no per-run caches — so repeated
 * invocations against the same CallCandidate produce identical results. Note that
 * `classify()` can throw when the language plugin emits a malformed CallCandidate (empty
 * target, adjacent dots) or a malformed ImportEdge; both signal upstream contract
 * violations and are surfaced rather than swallowed.
 *
 * No `dropCallees`: tRPC has no logger surface that belongs in drop-list category C.
 */
class TrpcEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsTrpcManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyTrpcCall(call, ctx)
  }
}

/**
 * Ready-to-register instance. Callers pass this to `@aburi/plugin-registry` or a scan
 * pipeline. The type annotation is omitted deliberately: `class implements EffectPlugin`
 * already enforces the structural contract, and inferring the narrow class type keeps the
 * manifest literals visible to consumers that want to compare against them without a
 * separate manifest import.
 */
export const trpcEffectsPlugin = new TrpcEffectsPlugin()

export { TrpcEffectsPlugin }
