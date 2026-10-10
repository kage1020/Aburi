import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyTrpcCall } from "./classify"
import { effectsTrpcManifest } from "./manifest"

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
