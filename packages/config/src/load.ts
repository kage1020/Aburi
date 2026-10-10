import type { Config, FrameworkPlugin } from "@aburi/types"
import { type FindConfigOptions, findConfig } from "./discovery"
import { frameworkHintPlugins } from "./framework-hints"
import { readConfigFile } from "./parser"

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
      /** One framework plugin per `frameworkHints` entry, in config order. */
      syntheticPlugins: readonly FrameworkPlugin[]
    }

const AUTODETECT_FALLBACK: LoadedConfig = {
  found: false,
  source: null,
  config: {},
  syntheticPlugins: [],
} as const

export type ConfigSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "autodetect" }

/** The `ConfigSource` for what `findConfig` answered. */
export function configSourceFrom(found: string | null): ConfigSource {
  return found === null ? { kind: "autodetect" } : { kind: "file", path: found }
}

export async function loadConfigFrom(source: ConfigSource): Promise<LoadedConfig> {
  if (source.kind === "autodetect") return AUTODETECT_FALLBACK
  const config = await readConfigFile(source.path)
  return {
    found: true,
    source: source.path,
    config,
    syntheticPlugins: frameworkHintPlugins(config),
  }
}

export async function loadConfig(options: FindConfigOptions = {}): Promise<LoadedConfig> {
  return loadConfigFrom(configSourceFrom(await findConfig(options)))
}
