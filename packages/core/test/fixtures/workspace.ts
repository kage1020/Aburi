import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { type ScratchWorkspace, useScratchWorkspace } from "@aburi/test-support"

export interface WorkspaceTree extends ScratchWorkspace {
  mkdir(rel: string): Promise<void>
  writeJson(rel: string, value: unknown): Promise<void>
  writePackage(dir: string, manifest: Record<string, unknown>): Promise<void>
  writePnpmWorkspace(...patterns: string[]): Promise<void>
  /** Twelve files by default: enough for the language census to count the language. */
  writeLanguageFiles(dir: string, extension: string, count?: number): Promise<void>
}

export function useWorkspaceTree(prefix: string): WorkspaceTree {
  const scratch = useScratchWorkspace(prefix)
  const writeJson = (rel: string, value: unknown) => scratch.writeSource(rel, JSON.stringify(value))
  return {
    get root() {
      return scratch.root
    },
    writeSource: (rel, content) => scratch.writeSource(rel, content),
    async mkdir(rel) {
      await mkdir(join(scratch.root, rel), { recursive: true })
    },
    writeJson,
    writePackage: (dir, manifest) => writeJson(join(dir, "package.json"), manifest),
    writePnpmWorkspace: (...patterns) =>
      scratch.writeSource(
        "pnpm-workspace.yaml",
        `packages:\n${patterns.map((pattern) => `  - ${JSON.stringify(pattern)}\n`).join("")}`,
      ),
    async writeLanguageFiles(dir, extension, count = 12) {
      for (let index = 0; index < count; index += 1) {
        await scratch.writeSource(join(dir, `f${index}${extension}`), "x")
      }
    },
  }
}
