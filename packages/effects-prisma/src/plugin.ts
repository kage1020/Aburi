import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyPrismaCall } from "./classify"
import { effectsPrismaManifest } from "./manifest"

/**
 * Prisma effect plugin: maps `prisma.<model>.<verb>` and `prisma.$transaction` call
 * expressions onto the core `db.read` / `db.write` / `db.transaction` vocabulary. `classify`
 * is pure (effect-plugin.md) and throws on a malformed CallCandidate — an
 * upstream contract violation, surfaced rather than swallowed.
 */
class PrismaEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsPrismaManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyPrismaCall(call, ctx)
  }
}

/** Ready-to-register instance; left unannotated so the manifest literals stay visible. */
export const prismaEffectsPlugin = new PrismaEffectsPlugin()

export { PrismaEffectsPlugin }
