import { access, constants } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { ConfigError, MISSING_FILE_ERRNOS } from "./errors"

/** File names checked in priority order. JSONC takes precedence so comments survive a round-trip. */
const CONFIG_FILENAMES = ["aburi.jsonc", "aburi.json"] as const

export interface FindConfigOptions {
  cwd?: string
}

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
    if (MISSING_FILE_ERRNOS.has(errno)) return false
    throw new ConfigError(
      `Failed to probe config candidate ${path} (${errno})`,
      { code: "config-read-failed" },
      { cause: err },
    )
  }
}
