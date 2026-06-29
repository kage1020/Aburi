import type { Config, PluginManifest } from "@aburi/types"
import { type FindConfigOptions, findConfig } from "./discovery"
import { normalizeFrameworkHints } from "./framework-hints"
import { readConfigFile } from "./parser"

export interface LoadedConfig {
  config: Config
  /** Absolute path of the file loaded, or null when no config existed and `config` is `{}`. */
  source: string | null
  /** Synthesized framework-type PluginManifest array from `config.frameworkHints[]`. */
  syntheticPlugins: PluginManifest[]
}

/**
 * Discover, read, validate, and normalize an Aburi config.
 *
 * When no config exists, returns `{ config: {}, source: null, syntheticPlugins: [] }` — the
 * caller falls back to autodetect (config.md §12). When one exists, full validation and
 * frameworkHints normalization run before returning.
 */
export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  const source = await findConfig(options)
  if (source === null) {
    return { config: {}, source: null, syntheticPlugins: [] }
  }
  const config = await readConfigFile(source)
  return { config, source, syntheticPlugins: normalizeFrameworkHints(config) }
}
