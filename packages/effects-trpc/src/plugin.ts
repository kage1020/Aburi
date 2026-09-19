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
 * tRPC effect plugin: maps client procedure calls onto the core `network.rpc` vocabulary,
 * recording the router-relative procedure path in `derivedBy`. `classify` is pure
 * (effect-plugin.md) and throws on a malformed CallCandidate or ImportEdge —
 * upstream contract violations. No `dropCallees`: tRPC has no logger surface.
 */
class TrpcEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsTrpcManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyTrpcCall(call, ctx)
  }
}

/** Ready-to-register instance; left unannotated so the manifest literals stay visible. */
export const trpcEffectsPlugin = new TrpcEffectsPlugin()

export { TrpcEffectsPlugin }
