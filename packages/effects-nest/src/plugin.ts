import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyNestCall } from "./classify"
import { effectsNestManifest } from "./manifest"

/**
 * NestJS effect plugin: maps `<...>.<eventBus|EventEmitter2>.emit(...)` call expressions
 * onto the core `event.publish` vocabulary. `classify` is pure (effect-plugin.md) and
 * throws on a malformed CallCandidate — an upstream contract violation.
 *
 * No `dropCallees`: Nest's `Logger` is injected per provider, so a prefix drop would sweep
 * too widely (docs/design/effect-plugin.md).
 */
class NestEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsNestManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyNestCall(call, ctx)
  }
}

/** Ready-to-register instance; left unannotated so the manifest literals stay visible. */
export const nestEffectsPlugin = new NestEffectsPlugin()

export { NestEffectsPlugin }
