import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyNestCall } from "./classify"
import { effectsNestManifest } from "./manifest"

class NestEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsNestManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyNestCall(call, ctx)
  }
}

/** Left unannotated so the manifest literals stay visible. */
export const nestEffectsPlugin = new NestEffectsPlugin()

export { NestEffectsPlugin }
