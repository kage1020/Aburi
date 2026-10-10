import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/plugin"

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

    expect(tree.rootNode).toBeNull()
  })

  it("frees every tree across a long run of parse-and-release cycles", async () => {
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
