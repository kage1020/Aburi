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
 * Drizzle effect plugin. Maps Drizzle ORM call expressions into the core `db.read` /
 * `db.write` / `db.transaction` effect vocabulary. See `classifyDrizzleCall` for the
 * detection strategy (chain-collapse + import-gate).
 *
 * Pure with respect to plugin state — no lazy resources, no per-run caches — so
 * repeated invocations against the same CallCandidate produce identical results. Note
 * that `classify()` can throw when the language plugin emits a malformed CallCandidate
 * (empty target, adjacent dots) or a shape-matched transaction/batch call with
 * `argumentCount === 0`; both signal upstream contract violations and are surfaced
 * rather than swallowed.
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
 * the manifest literals visible to consumers that want to compare against them without
 * a separate manifest import.
 */
export const drizzleEffectsPlugin = new DrizzleEffectsPlugin()

export { DrizzleEffectsPlugin }
