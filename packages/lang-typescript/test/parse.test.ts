import { describe, expect, it } from "vitest"
import { parseErrorsOf, parseSource } from "./fixtures/ctx"

describe("parseTypescriptFile", () => {
  it.each([
    ["src/a.ts", "export function foo(): number { return 1 }"],
    ["src/a.mts", "export const x = 1"],
    ["src/a.cts", "export const x = 1"],
    ["src/a.tsx", "export const Foo = () => <div />"],
    ["src/a.jsx", "export const Foo = () => <div />"],
    ["src/a.js", "export function add(a, b) { return a + b }"],
    ["src/a.mjs", "export const x = 1"],
    ["src/a.cjs", "export const x = 1"],
  ])("parses %s and returns a Tree", async (path, content) => {
    const result = await parseSource(content, path)

    expect(result.errors).toEqual([])
    expect(result.tree?.rootNode).not.toBeNull()
  })

  it("reports recoverable errors for a source with a syntax mistake", async () => {
    const result = await parseSource("function foo( { return 1 }", "src/bad.ts")

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.every((e) => e.recoverable)).toBe(true)
  })

  it("names a token the parser had to insert as missing", async () => {
    expect(await parseErrorsOf("export function f(a: any) { save(a + ) }")).toContain(
      "1:37 missing token",
    )
  })

  it("refuses a path whose extension it has no grammar for", async () => {
    await expect(parseSource("const x = 1", "src/a.py")).rejects.toThrow(
      'no grammar registered for extension ".py"',
    )
  })
})
