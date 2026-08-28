import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scan } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { LanguagePlugin, Logger } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/** The one thing this test asks of a tree-sitter tree: whether it still has a root. */
interface TreeHandle {
  rootNode: unknown
}

/**
 * The leak this guards is invisible from the IR: a scan that never frees a tree produces
 * exactly the same Document as one that does, and only says so by running out of WASM heap
 * some thousands of files later. So the assertion is on the handles themselves — every tree
 * the real plugin hands to the real scan is dead by the time the scan returns.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-tree-release-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

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

async function scanWith(language: LanguagePlugin): Promise<void> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  await scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [language],
    frameworks: [],
    effects: [],
    registry,
    logger: silentLogger,
    components: [],
  })
}

describe("a scan through the real plugin", () => {
  it("leaves no parse tree alive behind it", async () => {
    await writeSource("a.ts", "export function alpha() { return 1 }\n")
    await writeSource("b.ts", "export class Beta { run() { return alpha() } }\n")
    await writeSource("c.tsx", "export const Gamma = () => <div />\n")

    const handedOut: TreeHandle[] = []
    await scanWith(recording(handedOut))

    expect(handedOut).toHaveLength(3)
    expect(handedOut.map((tree) => tree.rootNode)).toEqual([null, null, null])
  })

  it("frees the tree of a file whose extraction threw, which the scan reports and continues past", async () => {
    await writeSource("boom.ts", "export function boom() { return 1 }\n")

    const handedOut: TreeHandle[] = []
    const base = recording(handedOut)
    const exploding: LanguagePlugin = Object.create(base)
    exploding.extractSymbols = () => {
      throw new Error("extraction exploded")
    }

    await scanWith(exploding)

    expect(handedOut).toHaveLength(1)
    expect(handedOut[0]?.rootNode).toBeNull()
  })
})
