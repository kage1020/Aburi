import { access, constants } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

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
 * a config above the workspace root is still honored (the user may share one across repos),
 * and `aburi init` is responsible for placing the file at the right level.
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
  } catch {
    return false
  }
}
