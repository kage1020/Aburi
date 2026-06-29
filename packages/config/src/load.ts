import type { Config, PluginManifest } from "@aburi/types"
import { type FindConfigOptions, findConfig } from "./discovery"
import { normalizeFrameworkHints } from "./framework-hints"
import { readConfigFile } from "./parser"

/**
 * Discriminated by `found`: the autodetect branch (no config on disk) carries an empty
 * config and a null source, the loaded branch carries the validated config plus its
 * synthesized framework-hint plugins. Callers narrow with `if (result.found)` instead of
 * checking `source === null`, eliminating the "I forgot to handle the autodetect case" bug.
 */
export type LoadedConfig =
  | {
      found: false
      source: null
      config: Record<string, never>
      syntheticPlugins: readonly []
    }
  | {
      found: true
      source: string
      config: Config
      syntheticPlugins: readonly PluginManifest[]
    }

const AUTODETECT_FALLBACK: LoadedConfig = {
  found: false,
  source: null,
  config: {},
  syntheticPlugins: [],
} as const

/**
 * Discover, read, validate, and normalize an Aburi config.
 *
 * When no config exists, returns the autodetect-fallback variant so the caller can branch on
 * `found` and run its detector. When one exists, full schema validation and frameworkHints
 * normalization run before returning. Filesystem errors during discovery (EACCES, EIO, …)
 * surface as ConfigError — they are NOT treated as "no config".
 */
export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  const source = await findConfig(options)
  if (source === null) return AUTODETECT_FALLBACK
  const config = await readConfigFile(source)
  return {
    found: true,
    source,
    config,
    syntheticPlugins: normalizeFrameworkHints(config),
  }
}
