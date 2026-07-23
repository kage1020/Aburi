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
 * Drizzle effect plugin. Sits behind the language plugin's `walkBody` output, mapping
 * Drizzle ORM call expressions into the core `db.read` / `db.write` / `db.transaction`
 * effect vocabulary.
 *
 * `init` and `classify` are both pure with respect to plugin state — no lazy resources,
 * no per-run caches — so repeated invocations against the same CallCandidate produce
 * identical results. This matches the per-call timeout contract in
 * effect-plugin.md §5.1.1 and the "pure classifier" recommendation in §11.1.
 */
class DrizzleEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsDrizzleManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyDrizzleCall(call, ctx)
  }
}

/**
 * Ready-to-register instance. Callers pass this to `@aburi/plugin-registry` or a scan
 * pipeline. The type annotation is omitted deliberately: `class implements EffectPlugin`
 * already enforces the structural contract, and inferring the narrow class type keeps
 * the manifest literals (`readonly ["effects-plugin:drizzle"]`, `"effects-drizzle"`)
 * visible to consumers that want to compare against them without a separate manifest
 * import.
 */
export const drizzleEffectsPlugin = new DrizzleEffectsPlugin()

export { DrizzleEffectsPlugin }
