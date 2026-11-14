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
  readonly manifest: typeof effectsNestManifest = effectsNestManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyNestCall(call, ctx)
  }
}

export const nestEffectsPlugin: NestEffectsPlugin = new NestEffectsPlugin()

export { NestEffectsPlugin }
