import { describe, expect, it } from "vitest"
import { extractSymbols, normalizeAst, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

async function normalizeFirstSymbol(source: string): Promise<string> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const symbols = extractSymbols(requireTree(result.tree), ctx)
  const target = symbols[0]
  if (target === undefined) throw new Error("no symbols in fixture")
  return normalizeAst(target)
}

describe("normalizeAst — S1-S5 language plugin contract", () => {
  it("S1: adding a comment inside the body leaves the normalized form unchanged", async () => {
    const withoutComment = await normalizeFirstSymbol("export function f() { return 1 }")
    const withComment = await normalizeFirstSymbol("export function f() { /* note */ return 1 }")
    expect(withoutComment).toBe(withComment)
  })

  it("S2: whitespace / indentation differences leave the normalized form unchanged", async () => {
    const flat = await normalizeFirstSymbol("export function f(){return 1}")
    const pretty = await normalizeFirstSymbol("export function f() {\n  return 1\n}")
    expect(flat).toBe(pretty)
  })

  it("S3: adding a statement changes the normalized form", async () => {
    const one = await normalizeFirstSymbol("export function f() { return 1 }")
    const two = await normalizeFirstSymbol("export function f() { const x = 0; return 1 }")
    expect(one).not.toBe(two)
  })

  it("S4: renaming an identifier changes the normalized form", async () => {
    const withX = await normalizeFirstSymbol("export function f(x: number) { return x }")
    const withY = await normalizeFirstSymbol("export function f(y: number) { return y }")
    expect(withX).not.toBe(withY)
  })

  it("S5: changing a literal value changes the normalized form", async () => {
    const one = await normalizeFirstSymbol("export function f() { return 1 }")
    const two = await normalizeFirstSymbol("export function f() { return 2 }")
    expect(one).not.toBe(two)
  })
})
