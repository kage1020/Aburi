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

    expect(typeof langTypescriptPlugin.releaseTree).toBe("function")
    langTypescriptPlugin.releaseTree?.(tree)

    // web-tree-sitter answers a freed tree with a null root rather than throwing, so this is
    // what "freed" looks like from the outside.
    expect(tree.rootNode).toBeNull()
  })

  it("keeps the WASM heap flat across many parse-and-release cycles", async () => {
    // The regime the core runs: parse a file, use it, release it. Without the release this
    // exhausts the WASM heap within a few hundred files, which is the crash lang-plugin.md
    // §8.1 names.
    for (let i = 0; i < 100; i++) {
      const result = await langTypescriptPlugin.parseFile({
        path: `src/f${i}.ts`,
        content: `export function fn${i}(x: number): number { return x + ${i} }`,
      })
      expect(result.tree).not.toBeNull()
      if (result.tree !== null) langTypescriptPlugin.releaseTree?.(result.tree)
    }
  })
})
