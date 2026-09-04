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
 * Read, validate, and normalize the config at `source` — or return the autodetect fallback
 * when `source` is `null`, which is how "discovery found nothing" is spelled.
 *
 * Separate from `loadConfig` because a caller that has already decided *which* file to read
 * must be able to say so without going back through discovery. `aburi diff` is that caller:
 * `cli-spec.md` §6.4 step 3 requires the base scan to use the head's `aburi.json`, and the
 * base scan runs with its cwd inside the base worktree, where discovery would find the base
 * copy again. A config change would then read as a whole-IR change.
 *
 * `null` is part of the decision rather than an absence of one. A head revision with no
 * config on disk must scan the base by autodetect too, even when the base ref still carries
 * an `aburi.json` — otherwise deleting the config reports the whole workspace as changed,
 * which is the same defect from the other side.
 */
export async function loadConfigFrom(source: string | null): Promise<LoadedConfig> {
  if (source === null) return AUTODETECT_FALLBACK
  const config = await readConfigFile(source)
  return {
    found: true,
    source,
    config,
    syntheticPlugins: normalizeFrameworkHints(config),
  }
}

/**
 * Discover, read, validate, and normalize an Aburi config.
 *
 * When no config exists, returns the autodetect-fallback variant so the caller can branch on
 * `found` and run its detector. When one exists, full schema validation and frameworkHints
 * normalization run before returning. Filesystem errors during discovery (EACCES, EIO, …)
 * surface as ConfigError — they are NOT treated as "no config".
 */
export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  return loadConfigFrom(await findConfig(options))
}
