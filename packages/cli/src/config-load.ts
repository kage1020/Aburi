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

/**
 * Which config a run reads, decided once so the answer survives a change of directory.
 *
 * The type exists because a config path is only unambiguous while the working directory
 * stays put. `aburi diff` moves it — the base scan runs with its cwd inside a temporary
 * worktree — so anything still expressed as "discover from cwd" or "this path, relative to
 * cwd" answers differently for the two scans. Pinning happens once, against the invoking
 * cwd, and both scans are then handed the same answer.
 */
export type PinnedConfig = ConfigSource

/**
 * Decide which config a run reads, without reading it.
 *
 * Discovery and the `--config` / `ABURI_CONFIG` override both anchor to the given `cwd`,
 * per the Config Resolution Order list in `cli-spec.md`. A config in that directory
 * therefore wins over one in an ancestor.
 *
 * The marker-detected workspace root plays no part here. It is the base for Symbol id
 * paths, for the config's own relative globs (`ignore`, `components[].roots`) and for
 * relative plugin specifiers — but not for locating the config, which is why a
 * package-local config can name paths that resolve against a directory above it.
 *
 * Separated from the read so that `aburi diff` can pin the head's answer before it moves the
 * working directory — step 3 of the ref-form Behavior `cli-spec.md` gives `aburi diff`, which
 * hands the base scan the head's config. Both halves of a diff then read one file, and a
 * commit touching only `aburi.json` stops reading as a change to every Symbol in the
 * workspace.
 */
export async function pinConfig(
  cwd: string,
  overridePath: string | undefined,
): Promise<PinnedConfig> {
  // An override is a path the caller typed, so it is resolved rather than probed: naming a
  // file that is not there is an error the read reports, not a fall-through to discovery.
  if (overridePath !== undefined) return { kind: "file", path: resolve(cwd, overridePath) }
  try {
    return configSourceFrom(await findConfig({ cwd }))
  } catch (error) {
    throw classifyConfigError(error)
  }
}

/**
 * Read the config a `PinnedConfig` names, wherever the working directory has since moved to.
 *
 * The absolute-path check is the one thing that makes that sentence true, so it is enforced
 * here rather than stated in a docblock. `readConfigFile` calls `readFile` with the string
 * it is given, so a relative `path` would silently re-acquire the cwd dependence pinning
 * exists to remove — and would then ride `LoadedConfig.source` into `ScanReport.configSource`,
 * where every consumer expects a path it can compare against the workspace root. `@aburi/core`
 * guards its own root the same way, for the same reason (`assertWorkspaceRootAbsolute`).
 */
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

/**
 * Decide which config to read, anchored to `cwd`, and read it — the two halves composed, for
 * a caller that reads a config once and never moves.
 */
export async function resolveConfig(
  cwd: string,
  overridePath: string | undefined,
): Promise<LoadedConfig> {
  return loadPinnedConfig(await pinConfig(cwd, overridePath))
}

/**
 * Map a failure of the config load onto the CLI exit-code table (cli-spec.md).
 *
 * Three different people are at fault on this path and only one of them is the reader.
 *
 * A `ConfigError` naming the file's *content* is theirs, and exit 2 sends them to edit it. So
 * is `config-not-found` — a `--config` path that names nothing is a mistyped argument, which
 * the exit-code table spends the same code on. `config-read-failed` is neither: the file is
 * there and the filesystem refused it, which the exit-code table spends exit 1 on, and no edit
 * to `aburi.json` changes a permission or a mount. All three keep the
 * `Failed to load Aburi config:` prefix, because it names the phase that failed rather than
 * who is answerable for it.
 *
 * Anything that is not a `ConfigError` is Aburi's own, and the reader is told so: `formatAjvErrors`
 * throws a bare `Error` when ajv reports failure with an empty `errors[]`, and reporting that
 * on exit 2 sends the reader through their file for something that is not in it.
 */
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

/**
 * `config.output.dir`, or `undefined` when nothing sets one — for the two commands that need
 * the name without needing the rest of the config.
 *
 * Takes the config already decided rather than a `cwd` to decide it from, so that `aburi
 * diff` can settle the question once and spend it here and on both of its scans.
 *
 * A config that cannot be read stops the caller rather than falling back to `out`. This
 * setting decides where the artefacts are, so an unread config means their location is
 * unknown: writing to `out` anyway leaves them where the next step does not look, and reading
 * from `out` anyway reports "no IR file" about a directory the workspace never uses. Either
 * is a confident wrong answer laid over a swallowed error.
 */
export async function configuredOutputDir(pinned: PinnedConfig): Promise<string | undefined> {
  const loaded = await loadPinnedConfig(pinned)
  return loaded.config.output?.dir
}
