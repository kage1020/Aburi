import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
 * An empty directory per test, created in `beforeEach` and removed in `afterEach`. Call it
 * at module scope; `prefix` names the tmpdir so a leaked one can be traced to its suite.
 */
export function useScratchWorkspace(prefix: string): ScratchWorkspace {
  let root = ""

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `aburi-${prefix}-`))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
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
