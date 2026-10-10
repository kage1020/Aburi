import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach } from "vitest"

export interface ScratchWorkspace {
  /** Absolute path of the current test's directory; only meaningful inside a test or hook. */
  readonly root: string
  /** Write `content` at `rel` under `root`, creating parent directories as needed. */
  writeSource(rel: string, content: string): Promise<void>
}

/**
 * A fresh directory under the OS temp dir for every test, removed afterwards. Never inside the
 * repository: config discovery walks up to the repository's own `aburi.json`. `root` is the real path,
 * so it compares equal to what the code under test resolves (macOS links its temp dir). Removal
 * retries because Windows releases a just-closed file's handle late and `rm` meets it as ENOTEMPTY.
 */
export function useScratchWorkspace(prefix: string): ScratchWorkspace {
  let root = ""

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), `aburi-${prefix}-`)))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  return {
    get root() {
      return root
    },
    async writeSource(rel, content) {
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
    },
  }
}
