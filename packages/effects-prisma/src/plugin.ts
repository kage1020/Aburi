import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyPrismaCall } from "./classify"
import { effectsPrismaManifest } from "./manifest"

class PrismaEffectsPlugin implements EffectPlugin {
  readonly manifest: typeof effectsPrismaManifest = effectsPrismaManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null {
    return classifyPrismaCall(call, ctx)
  }
}

export const prismaEffectsPlugin: PrismaEffectsPlugin = new PrismaEffectsPlugin()

export { PrismaEffectsPlugin }
