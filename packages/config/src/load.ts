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
 * Which config to read, as a decision already made — the input counterpart of
 * `LoadedConfig`, and discriminated the same way for the same reason.
 *
 * `autodetect` is a decision, not the absence of one: it says "no config on disk, run the
 * detector", and a caller handed it must not go looking for one. Spelling that as `null`
 * would reintroduce on the input side the "I forgot to handle the autodetect case" bug that
 * `LoadedConfig.found` exists to eliminate — and `loadConfigFrom(null)` reads most naturally
 * as "read from the default", which is the opposite of what it means.
 *
 * `path` is absolute. A relative one would resolve against `process.cwd()` inside
 * `readConfigFile`, which is exactly the working-directory dependence a decided source is
 * for; callers that accept a user-typed path resolve it before they get here.
 */
export type ConfigSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "autodetect" }

/** The `ConfigSource` for what `findConfig` answered. */
export function configSourceFrom(found: string | null): ConfigSource {
  return found === null ? { kind: "autodetect" } : { kind: "file", path: found }
}

/**
 * Read, validate, and normalize the config a `ConfigSource` names.
 *
 * Separate from `loadConfig` because a caller that has already decided *which* file to read
 * must be able to say so without going back through discovery — and, crucially, without the
 * answer depending on where the process happens to be standing. `aburi diff` is that caller:
 * `cli-spec.md` §6.4 step 3 requires the base scan to use the head's `aburi.json`, and the
 * base scan runs with its cwd inside the base worktree, where discovery would find the base
 * copy again. A config change would then read as a whole-IR change.
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
 * Discover, read, validate, and normalize an Aburi config.
 *
 * When no config exists, returns the autodetect-fallback variant so the caller can branch on
 * `found` and run its detector. When one exists, full schema validation and frameworkHints
 * normalization run before returning. Filesystem errors during discovery (EACCES, EIO, …)
 * surface as ConfigError — they are NOT treated as "no config".
 */
export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  return loadConfigFrom(configSourceFrom(await findConfig(options)))
}
