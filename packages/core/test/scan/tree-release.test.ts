import { describe, expect, it } from "vitest"
import type { TreeReleaseFailure } from "../../src"
import {
  expectExtracted,
  runPipeline,
  type Script,
  ScriptedLanguagePlugin,
} from "../fixtures/plugins"

function run(plugin: ScriptedLanguagePlugin) {
  const treeReleaseFailures: TreeReleaseFailure[] = []
  return { result: runPipeline({ language: plugin, treeReleaseFailures }), treeReleaseFailures }
}

describe("the scripted plugin", () => {
  it("has a releaseTree that needs its receiver, so recording it proves the receiver survived", () => {
    const detached = new ScriptedLanguagePlugin().releaseTree
    expect(() => detached({})).toThrow()
  })
})

describe("runFilePipeline — releasing the parse tree", () => {
  it("releases the tree it was handed once, after the last candidate", async () => {
    const plugin = new ScriptedLanguagePlugin({ candidates: ["one", "two"] })
    const { symbols } = expectExtracted(await run(plugin).result)

    expect(symbols).toHaveLength(2)
    expect(plugin.order).toEqual([
      "extractSymbols",
      "walkBody:one",
      "normalizeAst:one",
      "walkBody:two",
      "normalizeAst:two",
      "releaseTree",
    ])
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree a plugin built beside the error that refused it", async () => {
    const plugin = new ScriptedLanguagePlugin({
      parseErrors: [{ message: "generated blob", line: 1, column: 1, recoverable: false }],
    })
    const { result } = run(plugin)

    expect((await result).kind).toBe("parse-failed")
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it.each<[string, Script, RegExp | typeof TypeError]>([
    ["extractSymbols throws", { throwFrom: "extractSymbols" }, /stub extractSymbols exploded/],
    ["walkBody throws", { throwFrom: "walkBody" }, /stub walkBody exploded/],
    ["normalizeAst throws", { throwFrom: "normalizeAst" }, /stub normalizeAst exploded/],
    ["the plugin's own import list is unusable", { imports: null }, TypeError],
  ])("releases the tree when %s, and lets the throw through unchanged", async (_label, script, thrown) => {
    const plugin = new ScriptedLanguagePlugin(script)
    await expect(run(plugin).result).rejects.toThrow(thrown)
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("calls no releaseTree when the plugin built no tree", async () => {
    const plugin = new ScriptedLanguagePlugin({
      tree: null,
      parseErrors: [{ message: "no tree", line: 1, column: 1, recoverable: false }],
    })
    const { result } = run(plugin)

    expect((await result).kind).toBe("parse-failed")
    expect(plugin.released).toEqual([])
  })

  it.each([undefined, null])("reads a releaseTree that is %s as nothing to free", async (value) => {
    const plugin = new ScriptedLanguagePlugin({ releaseTreeOverride: { value } })
    const { result, treeReleaseFailures } = run(plugin)

    expect(expectExtracted(await result).symbols).toHaveLength(1)
    expect(treeReleaseFailures).toEqual([])
  })
})

describe("runFilePipeline — when releasing the tree itself fails", () => {
  it.each<[string, Script, string]>([
    [
      "an Error by its message",
      { releaseThrows: new Error("wasm heap is gone") },
      "wasm heap is gone",
    ],
    ["a thrown string as itself", { releaseThrows: "just a string" }, "just a string"],
    [
      "a releaseTree that is not a function by what it is instead",
      { releaseTreeOverride: { value: ["not", "a", "function"] } },
      "releaseTree is a list, not a function",
    ],
  ])("records %s, and keeps the file's result", async (_label, script, detail) => {
    const { result, treeReleaseFailures } = run(new ScriptedLanguagePlugin(script))

    expect(expectExtracted(await result).symbols).toHaveLength(1)
    expect(treeReleaseFailures).toEqual([{ plugin: "lang-stub", file: "test.stub", detail }])
  })

  it("does not replace the error the file was already failing with", async () => {
    const plugin = new ScriptedLanguagePlugin({
      throwFrom: "walkBody",
      releaseThrows: new Error("wasm heap is gone"),
    })
    const { result, treeReleaseFailures } = run(plugin)

    await expect(result).rejects.toThrow("stub walkBody exploded")
    expect(treeReleaseFailures).toEqual([
      { plugin: "lang-stub", file: "test.stub", detail: "wasm heap is gone" },
    ])
  })
})
