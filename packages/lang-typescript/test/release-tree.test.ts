import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/plugin"

/**
 * `parseFile` hands its tree to the core and stops owning it, so the plugin's side of the
 * WASM convention in lang-plugin.md §8.1 is `releaseTree`: the core calls it once the tree's
 * last reader is done, and the WASM handle goes back to the heap there.
 */
describe("langTypescriptPlugin.releaseTree", () => {
  it("frees the tree it is given", async () => {
    const result = await langTypescriptPlugin.parseFile({
      path: "src/a.ts",
      content: "export function f() { return 1 }\n",
    })
    const tree = result.tree
    expect(tree).not.toBeNull()
    if (tree === null) return
    expect(tree.rootNode.type).toBe("program")

    langTypescriptPlugin.releaseTree(tree)

    // web-tree-sitter answers a freed tree with a null root rather than throwing, so this is
    // what "freed" looks like from the outside — and the oracle every case below reuses.
    expect(tree.rootNode).toBeNull()
  })

  it("frees every tree across a long run of parse-and-release cycles", async () => {
    // The regime the core runs. Asserted per iteration rather than by watching the heap:
    // exhausting it takes more files than a test should parse, and a loop that only checked
    // for a thrown error would pass with the release deleted.
    for (let i = 0; i < 100; i++) {
      const result = await langTypescriptPlugin.parseFile({
        path: `src/f${i}.ts`,
        content: `export function fn${i}(x: number): number { return x + ${i} }`,
      })
      const tree = result.tree
      expect(tree).not.toBeNull()
      if (tree === null) return
      langTypescriptPlugin.releaseTree(tree)
      expect(tree.rootNode).toBeNull()
    }
  })
})
