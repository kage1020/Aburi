import { scanWith } from "@aburi/test-harness"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { pluginOverriding } from "./fixtures/scan"

/** The one thing these tests ask of a tree-sitter tree: whether it still has a root. */
interface TreeHandle {
  rootNode: unknown
}

const workspace = useScratchWorkspace("tree-release")

async function scanThrough(language: LanguagePlugin) {
  const logger = recordingLogger()
  const result = await scanWith(workspace.root, { languages: [language] }, {}, { logger })
  return { result, warnings: logger.warnings }
}

describe("a scan through the real plugin", () => {
  it("leaves no parse tree alive behind it", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("b.ts", "export class Beta { run() { return alpha() } }\n")
    await workspace.writeSource("c.tsx", "export const Gamma = () => <div />\n")

    const handedOut: TreeHandle[] = []
    const recording = pluginOverriding((real) => ({
      parseFile: async (file) => {
        const result = await real.parseFile(file)
        if (result.tree !== null) handedOut.push(result.tree as TreeHandle)
        return result
      },
    }))
    const { result } = await scanThrough(recording)

    expect(handedOut.map((tree) => tree.rootNode)).toEqual([null, null, null])
    expect(result.treeReleaseFailures).toEqual([])
  })
})

describe("a plugin whose releaseTree fails", () => {
  const neverReleases = () =>
    pluginOverriding(() => ({
      releaseTree: () => {
        throw new Error("wasm heap is gone")
      },
    }))

  it("warns once for the plugin however many files it fails on, and counts the rest", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("b.ts", "export function beta() { return 2 }\n")
    await workspace.writeSource("c.ts", "export function gamma() { return 3 }\n")

    const { warnings } = await scanThrough(neverReleases())

    const named = warnings.filter((w) => w.includes("wasm heap is gone"))
    expect(named).toHaveLength(1)
    expect(named[0]).toContain("lang-typescript")
    expect(named[0]).toContain("a.ts")
    // Nothing else in the run states the consequence, and the exit code does not.
    expect(named[0]).toContain("exhausts the parser's heap")
    expect(warnings.filter((w) => w.includes("failed to release 3 parse trees"))).toHaveLength(1)
  })

  it("says nothing more when only one file failed, since the line above already named it", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")

    const { warnings } = await scanThrough(neverReleases())

    expect(warnings.filter((w) => w.includes("parse tree"))).toHaveLength(1)
  })
})
