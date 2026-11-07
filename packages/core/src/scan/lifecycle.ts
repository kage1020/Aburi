import type { EffectPlugin, FrameworkPlugin, LanguagePlugin, PluginContext } from "@aburi/types"
import { CoreError } from "../errors"
import { describeThrown } from "./faults"

type ScanPlugin = LanguagePlugin | FrameworkPlugin | EffectPlugin

export async function withPluginLifecycle<T>(
  plugins: readonly ScanPlugin[],
  ctx: PluginContext,
  work: () => Promise<T>,
): Promise<T> {
  const ready: ScanPlugin[] = []
  try {
    for (const plugin of new Set(plugins)) {
      await initialize(plugin, ctx)
      ready.push(plugin)
    }
    return await work()
  } finally {
    for (const plugin of ready.reverse()) await cleanUp(plugin, ctx)
  }
}

async function initialize(plugin: ScanPlugin, ctx: PluginContext): Promise<void> {
  // Plugins arrive as plain JavaScript, and one written before the core called `init` may lack it.
  if (typeof plugin.init !== "function") return
  try {
    await plugin.init(ctx)
  } catch (error) {
    throw new CoreError(
      `Plugin "${plugin.manifest.name}" failed to initialize: ${describeThrown(error)}`,
      { code: "plugin-init-failed", value: plugin.manifest.name },
      { cause: error },
    )
  }
}

async function cleanUp(plugin: ScanPlugin, ctx: PluginContext): Promise<void> {
  if (typeof plugin.cleanup !== "function") return
  try {
    await plugin.cleanup()
  } catch (error) {
    // Every plugin call is over by now, so what the scan found stands.
    ctx.log.warn(`Plugin "${plugin.manifest.name}" failed to clean up: ${describeThrown(error)}`)
  }
}
