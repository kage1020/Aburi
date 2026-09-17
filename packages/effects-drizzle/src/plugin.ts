import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyDrizzleCall } from "./classify"
import { effectsDrizzleManifest } from "./manifest"

/**
 * Drizzle effect plugin: maps Drizzle ORM call expressions onto the core `db.read` /
 * `db.write` / `db.transaction` vocabulary. `classify` is pure (effect-plugin.md) and throws
 * on a malformed CallCandidate or a zero-argument `transaction` / `batch` — upstream contract
 * violations, surfaced rather than swallowed.
 */
class DrizzleEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsDrizzleManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyDrizzleCall(call, ctx)
  }
}

/** Ready-to-register instance; left unannotated so the manifest literals stay visible. */
export const drizzleEffectsPlugin = new DrizzleEffectsPlugin()

export { DrizzleEffectsPlugin }
