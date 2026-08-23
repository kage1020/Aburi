import { resolve } from "node:path"
import {
  type LoadedConfig,
  loadConfig,
  normalizeFrameworkHints,
  readConfigFile,
} from "@aburi/config"
import { CliError, errorMessage } from "./errors"

/**
 * Discovery and the `--config` / `ABURI_CONFIG` override both anchor to the process `cwd`,
 * per the §11 precedence table. A config in the current package therefore wins over one in
 * an ancestor.
 *
 * The marker-detected workspace root plays no part here. It is the base for Symbol id
 * paths, for the config's own relative globs (`ignore`, `components[].roots`) and for
 * relative plugin specifiers — but not for locating the config, which is why a
 * package-local config can name paths that resolve against a directory above it.
 *
 * Shared rather than `aburi scan`'s own, because `aburi diff` and `aburi explain` have to
 * answer the same question: the first to place `diff.json`, the second to know where a scan
 * would have left its IR. A second copy would be a second answer to "which file is the
 * config", and the two would disagree the first time this precedence changed.
 */
export async function resolveConfig(
  cwd: string,
  overridePath: string | undefined,
): Promise<LoadedConfig> {
  try {
    if (overridePath !== undefined) {
      const absolute = resolve(cwd, overridePath)
      const config = await readConfigFile(absolute)
      return {
        found: true,
        source: absolute,
        config,
        syntheticPlugins: normalizeFrameworkHints(config),
      }
    }
    return await loadConfig({ cwd })
  } catch (error) {
    throw new CliError(`Failed to load Aburi config: ${errorMessage(error)}`, "config-error", {
      cause: error,
    })
  }
}

/**
 * `config.output.dir`, or `undefined` when nothing sets one — for the two commands that need
 * the name without needing the rest of the config.
 *
 * A config that cannot be read stops the caller rather than falling back to `out`. This
 * setting decides where the artefacts are, so an unread config means their location is
 * unknown: writing to `out` anyway leaves them where the next step does not look, and reading
 * from `out` anyway reports "no IR file" about a directory the workspace never uses. Either
 * is a confident wrong answer laid over a swallowed error.
 */
export async function configuredOutputDir(
  cwd: string,
  configPath: string | undefined,
): Promise<string | undefined> {
  const loaded = await resolveConfig(cwd, configPath)
  return loaded.config.output?.dir
}
