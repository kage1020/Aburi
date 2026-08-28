import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { LanguagePlugin, Logger } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-tree-release-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

/**
 * The real plugin, recording each tree it hands over. `Object.create` keeps the original as
 * the prototype rather than spreading it, which would copy the fields and lose the prototype
 * methods; the plugin holds no instance state, so the split receiver cannot diverge.
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

async function writeSource(rel: string, content: string): Promise<void> {
  await writeFile(join(workRoot, rel), content, "utf8")
}

interface RunResult {
  result: ScanResult
  warnings: string[]
}

async function scanWith(language: LanguagePlugin): Promise<RunResult> {
  const warnings: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message)
    },
    error: () => {},
  }
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  const result = await scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [language],
    frameworks: [],
    effects: [],
    registry,
    logger,
    components: [],
  })
  return { result, warnings }
}

describe("a scan through the real plugin", () => {
  it("leaves no parse tree alive behind it", async () => {
    await writeSource("a.ts", "export function alpha() { return 1 }\n")
    await writeSource("b.ts", "export class Beta { run() { return alpha() } }\n")
    await writeSource("c.tsx", "export const Gamma = () => <div />\n")

    const handedOut: TreeHandle[] = []
    const { result } = await scanWith(recording(handedOut))

    expect(handedOut).toHaveLength(3)
    expect(handedOut.map((tree) => tree.rootNode)).toEqual([null, null, null])
    expect(result.treeReleaseFailures).toEqual([])
  })

  it("frees the tree of a file whose extraction threw, and still reports the file", async () => {
    await writeSource("boom.ts", "export function boom() { return 1 }\n")

    const handedOut: TreeHandle[] = []
    const base = recording(handedOut)
    const exploding: LanguagePlugin = Object.create(base)
    exploding.extractSymbols = () => {
      throw new Error("extraction exploded")
    }

    const { result } = await scanWith(exploding)

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
    await writeSource("a.ts", "export function alpha() { return 1 }\n")
    await writeSource("b.ts", "export function beta() { return 2 }\n")

    const { result } = await scanWith(neverReleases())

    expect(result.treeReleaseFailures).toEqual([
      { plugin: "lang-typescript", file: "a.ts", detail: "wasm heap is gone" },
      { plugin: "lang-typescript", file: "b.ts", detail: "wasm heap is gone" },
    ])
  })

  it("leaves the Document complete and the run's other accounts empty", async () => {
    // A leaked tree costs the next run, not this one. Everything the scan was asked for is
    // here, which is exactly why the structured record has to exist: nothing else about this
    // result says anything is wrong.
    await writeSource("a.ts", "export function alpha() { return 1 }\n")

    const { result } = await scanWith(neverReleases())

    expect(result.ir.symbols.map((s) => s.name)).toContain("alpha")
    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
  })

  it("warns once for the plugin however many files it fails on, and counts the rest", async () => {
    await writeSource("a.ts", "export function alpha() { return 1 }\n")
    await writeSource("b.ts", "export function beta() { return 2 }\n")
    await writeSource("c.ts", "export function gamma() { return 3 }\n")

    const { warnings } = await scanWith(neverReleases())

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
    await writeSource("a.ts", "export function alpha() { return 1 }\n")

    const { warnings } = await scanWith(neverReleases())

    expect(warnings.filter((w) => w.includes("parse tree"))).toHaveLength(1)
  })
})
