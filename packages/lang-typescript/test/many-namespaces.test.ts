import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { parseSource, symbolsOf } from "./fixtures/ctx"

/**
 * LP8r — lang-plugin.md §8.2 for the namespace-beside-a-class check (LP8n): the statement list a
 * namespace is written in is read once, not once per namespace. Counted as the children
 * statement lists hand across the WASM boundary through `namedChildren`, since a timing budget
 * would measure the machine as much as the code: each namespace's own body is read once, so the
 * count grows with the file, and reading the list it sits in once per namespace makes it grow
 * with its square.
 */

async function childrenRead(source: string): Promise<number> {
  const { tree } = await parseSource("")
  if (tree === null) throw new Error("test fixture invariant: parse returned null")
  const prototype = Object.getPrototypeOf(tree.rootNode) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "namedChildren")
  const read = descriptor?.get
  if (descriptor === undefined || read === undefined) throw new Error("no namedChildren getter")
  let reads = 0
  Object.defineProperty(prototype, "namedChildren", {
    ...descriptor,
    get(this: Node) {
      const children = read.call(this) as unknown[]
      if (this.type === "program" || this.type === "statement_block") reads += children.length
      return children
    },
  })
  try {
    await symbolsOf(source)
  } finally {
    Object.defineProperty(prototype, "namedChildren", descriptor)
  }
  return reads
}

function topLevel(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `export namespace Api${i} {\n  export const path = "/v1/r${i}"\n}\n`,
  ).join("")
}

function nested(count: number): string {
  return `export namespace Pets {\n${topLevel(count)}}\n`
}

describe("LP8r: a file of many namespaces", () => {
  it.each([
    ["at the top level", topLevel],
    ["inside one outer namespace", nested],
  ])("reads statement lists in proportion to the file %s", async (_, shape) => {
    const few = await childrenRead(shape(10))
    const many = await childrenRead(shape(400))
    // Forty times the namespaces: linear reads grow about forty-fold, the square 1600-fold.
    expect(many).toBeLessThan(few * 80)
  })

  it("still finds the class a namespace merges into, in each statement list", async () => {
    const symbols = await symbolsOf(
      [
        "export class C {}",
        "export namespace C { export function m() {} }",
        "export namespace Outer {",
        "  export namespace C { export function m() {} }",
        "  export class D {}",
        "  export namespace D { export function m() {} }",
        "}",
        "",
      ].join("\n"),
    )
    const ids = symbols.map((symbol) => symbol.id)
    expect(ids).toContain("ts:src/a.ts#C::m")
    expect(ids).toContain("ts:src/a.ts#Outer.C.m")
    expect(ids).toContain("ts:src/a.ts#Outer.D::m")
  })
})
