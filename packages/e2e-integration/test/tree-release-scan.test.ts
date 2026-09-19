import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanWith, warningCollector } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The leak this guards is invisible from the IR: a scan that never frees a tree produces
 * exactly the same Document as one that does, and only says so by running out of WASM heap
 * some thousands of files later. So the assertion is on the handles themselves — every tree
 * the real plugin hands to the real scan is dead by the time the scan returns.
 */

/** The one thing this test asks of a tree-sitter tree: whether it still has a root. */
interface TreeHandle {
  rootNode: unknown
}

const workspace = useScratchWorkspace("tree-release")

/**
 * The real plugin, recording each tree it hands over. `Object.create` keeps the original as
 * the prototype rather than spreading it, which would lose the prototype methods; the plugin
 * holds no instance state, so the split receiver cannot diverge.
 */
function recording(handedOut: TreeHandle[]): LanguagePlugin {
  const base = langTypescriptPlugin as unknown as LanguagePlugin
  const wrapped: LanguagePlugin = Object.create(base)
  wrapped.parseFile = async (file) => {
    const result = await base.parseFile(file)
    if (result.tree !== null) handedOut.push(result.tree as TreeHandle)
    return result
  }
  return wrapped
}

async function scanThrough(language: LanguagePlugin) {
  const { logger, warnings } = warningCollector()
  const result = await scanWith(workspace.root, { languages: [language] }, {}, { logger })
  return { result, warnings }
}

describe("a scan through the real plugin", () => {
  it("leaves no parse tree alive behind it", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("b.ts", "export class Beta { run() { return alpha() } }\n")
    await workspace.writeSource("c.tsx", "export const Gamma = () => <div />\n")

    const handedOut: TreeHandle[] = []
    const { result } = await scanThrough(recording(handedOut))

    expect(handedOut).toHaveLength(3)
    expect(handedOut.map((tree) => tree.rootNode)).toEqual([null, null, null])
    expect(result.treeReleaseFailures).toEqual([])
  })

  it("frees the tree of a file whose extraction threw, and still reports the file", async () => {
    await workspace.writeSource("boom.ts", "export function boom() { return 1 }\n")

    const handedOut: TreeHandle[] = []
    const base = recording(handedOut)
    const exploding: LanguagePlugin = Object.create(base)
    exploding.extractSymbols = () => {
      throw new Error("extraction exploded")
    }

    const { result } = await scanThrough(exploding)

    expect(handedOut).toHaveLength(1)
    expect(handedOut[0]?.rootNode).toBeNull()
    expect(result.extractionFailures.map((f) => f.file)).toEqual(["boom.ts"])
    expect(result.skipped.map((s) => s.reason)).toEqual(["extraction-failed"])
  })
})

describe("a plugin whose releaseTree fails", () => {
  /** The real plugin with a `releaseTree` that always throws, as a broken plugin's would. */
  function neverReleases(): LanguagePlugin {
    const wrapped: LanguagePlugin = Object.create(langTypescriptPlugin as unknown as LanguagePlugin)
    wrapped.releaseTree = () => {
      throw new Error("wasm heap is gone")
    }
    return wrapped
  }

  it("is recorded once per file, naming the plugin and what it said", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("b.ts", "export function beta() { return 2 }\n")

    const { result } = await scanThrough(neverReleases())

    expect(result.treeReleaseFailures).toEqual([
      { plugin: "lang-typescript", file: "a.ts", detail: "wasm heap is gone" },
      { plugin: "lang-typescript", file: "b.ts", detail: "wasm heap is gone" },
    ])
  })

  it("leaves the Document complete and the run's other accounts empty", async () => {
    // A leaked tree costs the next run, not this one, which is exactly why the structured
    // record has to exist: nothing else about this result says anything is wrong.
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")

    const { result } = await scanThrough(neverReleases())

    expect(result.ir.symbols.map((symbol) => symbol.name)).toContain("alpha")
    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
  })

  it("warns once for the plugin however many files it fails on, and counts the rest", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")
    await workspace.writeSource("b.ts", "export function beta() { return 2 }\n")
    await workspace.writeSource("c.ts", "export function gamma() { return 3 }\n")

    const { warnings } = await scanThrough(neverReleases())

    const named = warnings.filter((w) => w.includes("wasm heap is gone"))
    expect(named).toHaveLength(1)
    expect(named[0]).toContain("lang-typescript")
    expect(named[0]).toContain("a.ts")
    // The consequence, because nothing else in the run states it and the exit code does not.
    expect(named[0]).toContain("exhausts the parser's heap")

    const counted = warnings.filter((w) => w.includes("failed to release 3 parse trees"))
    expect(counted).toHaveLength(1)
  })

  it("says nothing more when only one file failed, since the line above already named it", async () => {
    await workspace.writeSource("a.ts", "export function alpha() { return 1 }\n")

    const { warnings } = await scanThrough(neverReleases())

    expect(warnings.filter((w) => w.includes("parse tree"))).toHaveLength(1)
  })
})
