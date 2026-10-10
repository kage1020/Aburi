import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyDrizzleCall } from "./classify"
import { effectsDrizzleManifest } from "./manifest"

class DrizzleEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsDrizzleManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyDrizzleCall(call, ctx)
  }
}

/** Left unannotated so the manifest literals stay visible. */
export const drizzleEffectsPlugin = new DrizzleEffectsPlugin()

export { DrizzleEffectsPlugin }
