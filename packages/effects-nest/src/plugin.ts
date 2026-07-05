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
 * NestJS effect plugin. Sits behind the language plugin's `walkBody` output, mapping
 * `<...>.<eventBus|EventEmitter2>.emit(...)` call expressions into the core
 * `event.publish` effect vocabulary.
 *
 * `init` and `classify` are both pure with respect to plugin state — no lazy resources,
 * no per-run caches — so repeated invocations against the same CallCandidate produce
 * identical results. This matches the per-call timeout contract in
 * effect-plugin.md §5.1.1 and the "pure classifier" recommendation in §11.1.
 *
 * The plugin does NOT declare `dropCallees`: NestJS's built-in logger (`Logger` from
 * `@nestjs/common`) is dependency-injected on a per-provider basis, so a general prefix
 * drop would sweep too widely (design/details/effect-plugin.md §9.2).
 */
class NestEffectsPlugin implements EffectPlugin {
  readonly manifest = effectsNestManifest

  async init(_ctx: PluginContext): Promise<void> {}

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null {
    return classifyNestCall(call, ctx)
  }
}

/**
 * Ready-to-register instance. Callers pass this to `@aburi/plugin-registry` or a scan
 * pipeline. The type annotation is omitted deliberately: `class implements EffectPlugin`
 * already enforces the structural contract, and inferring the narrow class type keeps
 * the manifest literals (`readonly ["effects-plugin:nest"]`, `"effects-nest"`) visible
 * to consumers that want to compare against them without a separate manifest import.
 */
export const nestEffectsPlugin = new NestEffectsPlugin()

export { NestEffectsPlugin }
