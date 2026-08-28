import { resolve } from "node:path"
import {
  ConfigError,
  type LoadedConfig,
  loadConfig,
  normalizeFrameworkHints,
  readConfigFile,
} from "@aburi/config"
import { CliError, errorMessage } from "./errors"

/**
 * Discovery and the `--config` / `ABURI_CONFIG` override both anchor to the process `cwd`,
 * per `cli-spec.md §13 Config Resolution Order`. A config in the current package therefore
 * wins over one in an ancestor.
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
  // Outside the `try`, and the only line here that is: `resolve` cannot fail for a string
  // that has already been checked, and folding it in would report a path failure as a fault
  // of the file that path names.
  const absolute = overridePath === undefined ? null : resolve(cwd, overridePath)
  try {
    if (absolute !== null) {
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
    throw classifyConfigError(error)
  }
}

/**
 * Map a failure of the config load onto the CLI exit-code table (cli-spec.md §9).
 *
 * Three different people are at fault on this path and only one of them is the reader.
 *
 * A `ConfigError` naming the file's *content* is theirs, and exit 2 sends them to edit it.
 * `config-read-failed` is not: the file is there and the filesystem refused it, which §9
 * spends exit 1 on, and no edit to `aburi.json` changes a permission or a mount. Both keep
 * the `Failed to load Aburi config:` prefix, because it names the phase that failed rather
 * than who is answerable for it.
 *
 * Anything that is not a `ConfigError` is Aburi's own, and the reader is told so. It is not
 * hypothetical: `formatAjvErrors` throws a bare `Error` when ajv reports failure with an
 * empty `errors[]`, and says in its own docblock that this means ajv is in an unexpected
 * state rather than the config being wrong. It arrived as `Failed to load Aburi config: ajv
 * invariant violation…` on exit 2 — a sentence about the reader's file, naming something
 * they cannot find in it. This is the misdirection `classifyDiffError` avoids one file away,
 * for the same reason and in the same words.
 */
export function classifyConfigError(error: unknown): CliError {
  if (!(error instanceof ConfigError)) {
    return new CliError(
      `Internal error while loading the Aburi config: ${errorMessage(error)} This is a bug in ` +
        "Aburi, not in your configuration — please report it at " +
        "https://github.com/kage1020/Aburi/issues.",
      "runtime-error",
      { cause: error },
    )
  }
  const message = `Failed to load Aburi config: ${error.message}`
  switch (error.code) {
    case "config-parse-failed":
    case "config-invalid":
    case "duplicate-component-id":
    case "duplicate-hint-name":
    case "reserved-namespace":
      return new CliError(message, "config-error", { cause: error })
    case "config-read-failed":
      return new CliError(message, "runtime-error", { cause: error })
    default:
      return assertNever(error.code)
  }
}

/**
 * A new `ConfigErrorCode` has to be placed in the table above rather than defaulting into
 * either arm, because the two outcomes blame different people: one sends the reader to
 * `aburi.json`, the other tells them their machine refused a file.
 */
function assertNever(code: never): never {
  throw new Error(`Unhandled ConfigErrorCode: ${JSON.stringify(code)}`)
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
