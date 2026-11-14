import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyTrpcCall } from "./classify"
import { effectsTrpcManifest } from "./manifest"

class TrpcEffectsPlugin implements EffectPlugin {
  readonly manifest: typeof effectsTrpcManifest = effectsTrpcManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null {
    return classifyTrpcCall(call, ctx)
  }
}

export const trpcEffectsPlugin: TrpcEffectsPlugin = new TrpcEffectsPlugin()

export { TrpcEffectsPlugin }
