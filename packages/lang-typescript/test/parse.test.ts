import { describe, expect, it } from "vitest"
import { parseTypescriptFile } from "../src/index"

describe("parseTypescriptFile", () => {
  it("parses a TypeScript source and returns a Tree", async () => {
    const result = await parseTypescriptFile({
      path: "src/a.ts",
      content: "export function foo(): number { return 1 }",
    })
    expect(result.errors).toEqual([])
    expect(result.tree).not.toBeNull()
    expect(result.tree?.rootNode).not.toBeNull()
  })

  it("parses TSX via the tsx grammar (JSX-aware)", async () => {
    const result = await parseTypescriptFile({
      path: "src/a.tsx",
      content: "export const Foo = () => <div />",
    })
    expect(result.errors).toEqual([])
    expect(result.tree).not.toBeNull()
    expect(result.tree?.rootNode).not.toBeNull()
  })

  it("parses .jsx via the tsx grammar (JSX-aware, no TS syntax needed)", async () => {
    const result = await parseTypescriptFile({
      path: "src/a.jsx",
      content: "export const Foo = () => <div />",
    })
    expect(result.errors).toEqual([])
    expect(result.tree).not.toBeNull()
    expect(result.tree?.rootNode).not.toBeNull()
  })

  it("parses plain .js via the TypeScript grammar (permissively accepts modern JS)", async () => {
    const result = await parseTypescriptFile({
      path: "src/a.js",
      content: "export function add(a, b) { return a + b }",
    })
    expect(result.errors).toEqual([])
    expect(result.tree).not.toBeNull()
    expect(result.tree?.rootNode).not.toBeNull()
  })

  it("parses .mjs and .cjs via the TypeScript grammar", async () => {
    for (const path of ["src/a.mjs", "src/a.cjs"]) {
      const result = await parseTypescriptFile({
        path,
        content: "export const x = 1",
      })
      expect(result.errors).toEqual([])
      expect(result.tree).not.toBeNull()
    }
  })

  it("LP27: reports recoverable errors for a source with a syntax mistake", async () => {
    const result = await parseTypescriptFile({
      path: "src/bad.ts",
      content: "function foo( { return 1 }",
    })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.every((e) => e.recoverable)).toBe(true)
  })

  it("does not leak memory across many parses (WASM heap regime smoke test)", async () => {
    // 100 sequential parses in the same process. Without parser.delete() this exhausts
    // the WASM heap within a few hundred iterations; the regime keeps it flat.
    for (let i = 0; i < 100; i++) {
      const res = await parseTypescriptFile({
        path: `src/f${i}.ts`,
        content: `export function fn${i}(x: number): number { return x + ${i} }`,
      })
      expect(res.errors).toEqual([])
      expect(res.tree).not.toBeNull()
      res.tree?.delete()
    }
  })
})
