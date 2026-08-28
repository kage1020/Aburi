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
  // Outside the `try` so the `catch` below spans the config read and nothing else, which is
  // what it names. No behaviour rides on it: `resolve` does not throw for a `string`.
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
 * A `ConfigError` naming the file's *content* is theirs, and exit 2 sends them to edit it. So
 * is `config-not-found` — a `--config` path that names nothing is a mistyped argument, which
 * §9 spends the same code on. `config-read-failed` is neither: the file is there and the
 * filesystem refused it, which §9 spends exit 1 on, and no edit to `aburi.json` changes a
 * permission or a mount. All three keep the `Failed to load Aburi config:` prefix, because it
 * names the phase that failed rather than who is answerable for it.
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
  if (!(error instanceof ConfigError)) return internalFault(errorMessage(error), error)
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
    default: {
      // A new `ConfigErrorCode` is a type error here rather than a code that silently takes
      // an arm — and at runtime it degrades instead of throwing, because the compile-time
      // check protects this repo's build and not an installed tree: `@aburi/config` and
      // `@aburi/cli` version independently, so a compiled switch can meet a code it never
      // saw. Throwing there would discard the one thing the reader needs, which is what the
      // config error itself said.
      const unplaced: never = error.code
      return internalFault(
        `${error.message} (config error code ${JSON.stringify(unplaced)} has no exit code)`,
        error,
      )
    }
  }
}

/**
 * The report for a failure that is Aburi's own rather than the reader's.
 *
 * The instruction sits on its own line because nothing that reaches here ends in punctuation:
 * a thrown message run together with the next sentence is what a reader has to unpick, and an
 * empty one leaves a doubled space where the sentence should start.
 */
function internalFault(detail: string, cause: unknown): CliError {
  return new CliError(
    `Internal error while loading the Aburi config: ${detail}\n` +
      "This is a bug in Aburi, not in your configuration — please report it at " +
      "https://github.com/kage1020/Aburi/issues.",
    "runtime-error",
    { cause },
  )
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
