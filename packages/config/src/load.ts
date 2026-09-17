import type { Config, PluginManifest } from "@aburi/types"
import { type FindConfigOptions, findConfig } from "./discovery"
import { normalizeFrameworkHints } from "./framework-hints"
import { readConfigFile } from "./parser"

/**
 * Discriminated by `found` so callers narrow with `if (result.found)` and cannot forget the
 * autodetect case: no config on disk gives an empty config and a null source.
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
 * Which config to read, as a decision already made. `autodetect` says "no config on disk,
 * run the detector", and a caller handed it must not go looking for one; a `null` would
 * read as "use the default", the opposite of what it means.
 *
 * `path` is absolute: a relative one would resolve against `process.cwd()` inside
 * `readConfigFile`, which is exactly the working-directory dependence a decided source
 * exists to remove.
 */
export type ConfigSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "autodetect" }

/** The `ConfigSource` for what `findConfig` answered. */
export function configSourceFrom(found: string | null): ConfigSource {
  return found === null ? { kind: "autodetect" } : { kind: "file", path: found }
}

/**
 * Read, validate, and normalize the config a `ConfigSource` names, without discovery.
 *
 * `aburi diff` needs this: the `cli-spec.md` diff behaviour requires the base scan to use the
 * head's `aburi.json`, and the base scan runs with its cwd inside the base worktree, where
 * discovery would find the base copy again.
 */
export async function loadConfigFrom(source: ConfigSource): Promise<LoadedConfig> {
  if (source.kind === "autodetect") return AUTODETECT_FALLBACK
  const config = await readConfigFile(source.path)
  return {
    found: true,
    source: source.path,
    config,
    syntheticPlugins: normalizeFrameworkHints(config),
  }
}

/**
 * Discover, read, validate, and normalize an Aburi config. Filesystem errors during
 * discovery (EACCES, EIO, …) surface as `ConfigError`; only absence is "no config".
 */
export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  return loadConfigFrom(configSourceFrom(await findConfig(options)))
}
