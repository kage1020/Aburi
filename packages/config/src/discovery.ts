import { access, constants } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { ConfigError, MISSING_FILE_ERRNOS } from "./errors"

/** File names checked in priority order. JSONC takes precedence so comments survive a round-trip. */
const CONFIG_FILENAMES = ["aburi.jsonc", "aburi.json"] as const

export interface FindConfigOptions {
  /**
   * Starting directory. Discovery walks parent directories until a config is found or the
   * filesystem root is reached. Defaults to `process.cwd()`. Relative paths are resolved
   * against the current working directory.
   */
  cwd?: string
}

/**
 * Walk up from `cwd` and return the absolute path of the first `aburi.jsonc` / `aburi.json`
 * encountered, or null if none exists at any ancestor. Does not stop at workspace markers:
 * a config above the workspace root is still honored (the user may share one across repos).
 *
 * Non-existence is a value (`null`); permission / IO failures are errors. The caller must
 * not interpret a thrown ConfigError as "no config" — that conflation is the bug this
 * function exists to prevent.
 */
export async function findConfig(options: FindConfigOptions = {}): Promise<string | null> {
  const startRaw = options.cwd ?? process.cwd()
  const start = isAbsolute(startRaw) ? startRaw : resolve(process.cwd(), startRaw)

  let dir = start
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = resolve(dir, name)
      if (await fileExists(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (err: unknown) {
    const errno =
      err !== null &&
      typeof err === "object" &&
      typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "unknown"
    // The shared set: "no config here, keep walking". Anything else (EACCES, EIO, ELOOP,
    // EMFILE, ENAMETOOLONG, …) is a ConfigError, because swallowing it would make every
    // transient filesystem failure indistinguishable from an honest absence and send the
    // loader into autodetect mode with no diagnostic.
    if (MISSING_FILE_ERRNOS.has(errno)) return false
    throw new ConfigError(
      `Failed to probe config candidate ${path} (${errno})`,
      { code: "config-read-failed" },
      { cause: err },
    )
  }
}
