import { isAbsolute, resolve } from "node:path"
import {
  ConfigError,
  type ConfigSource,
  configSourceFrom,
  findConfig,
  type LoadedConfig,
  loadConfigFrom,
} from "@aburi/config"
import { CliError, errorMessage, internalFault, unplacedErrorCode } from "./errors"

export type PinnedConfig = ConfigSource

export async function pinConfig(
  cwd: string,
  overridePath: string | undefined,
): Promise<PinnedConfig> {
  if (overridePath !== undefined) return { kind: "file", path: resolve(cwd, overridePath) }
  try {
    return configSourceFrom(await findConfig({ cwd }))
  } catch (error) {
    throw classifyConfigError(error)
  }
}

export async function loadPinnedConfig(pinned: PinnedConfig): Promise<LoadedConfig> {
  if (pinned.kind === "file" && !isAbsolute(pinned.path)) {
    throw internalFault(
      CONFIG_PHASE,
      `pinned config path ${JSON.stringify(pinned.path)} is not absolute, so which file it ` +
        `names depends on the working directory`,
      undefined,
    )
  }
  try {
    return await loadConfigFrom(pinned)
  } catch (error) {
    throw classifyConfigError(error)
  }
}

export function classifyConfigError(error: unknown): CliError {
  if (!(error instanceof ConfigError))
    return internalFault(CONFIG_PHASE, errorMessage(error), error)
  const message = `Failed to load Aburi config: ${error.message}`
  switch (error.code) {
    case "config-not-found":
    case "config-parse-failed":
    case "config-invalid":
    case "duplicate-component-id":
    case "duplicate-hint-name":
    case "reserved-namespace":
      return new CliError(message, "config-error", { cause: error })
    case "config-read-failed":
      return new CliError(message, "runtime-error", { cause: error })
    default:
      return unplacedErrorCode(CONFIG_PHASE, "config", error, error.code)
  }
}

const CONFIG_PHASE = " while loading the Aburi config"

export async function configuredOutputDir(pinned: PinnedConfig): Promise<string | undefined> {
  const loaded = await loadPinnedConfig(pinned)
  return loaded.config.output?.dir
}
