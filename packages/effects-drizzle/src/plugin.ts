import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyDrizzleCall } from "./classify"
import { effectsDrizzleManifest } from "./manifest"

class DrizzleEffectsPlugin implements EffectPlugin {
  readonly manifest: typeof effectsDrizzleManifest = effectsDrizzleManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null {
    return classifyDrizzleCall(call, ctx)
  }
}

export const drizzleEffectsPlugin: DrizzleEffectsPlugin = new DrizzleEffectsPlugin()

export { DrizzleEffectsPlugin }
