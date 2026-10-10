import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyPrismaCall } from "./classify"
import { effectsPrismaManifest } from "./manifest"

class PrismaEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsPrismaManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyPrismaCall(call, ctx)
  }
}

/** Left unannotated so the manifest literals stay visible. */
export const prismaEffectsPlugin = new PrismaEffectsPlugin()

export { PrismaEffectsPlugin }
