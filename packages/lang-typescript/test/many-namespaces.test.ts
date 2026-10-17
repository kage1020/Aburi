import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { STATEMENT_LISTS } from "../src/extract-symbols"
import { parseSource, requireTree, walksOf } from "./fixtures/ctx"

const LIST_GETTERS = ["namedChildren", "children"] as const
const CHILD_METHODS = ["namedChild", "child"] as const

// Counts the children read off statement lists rather than timing the scan, which would measure
// the machine as much as the code. Every way of reading them is counted, so a rewrite stays guarded.
async function childrenRead(source: string): Promise<number> {
  const tree = requireTree((await parseSource("")).tree)
  const prototype = Object.getPrototypeOf(tree.rootNode) as object
  const originals = new Map<string, PropertyDescriptor>()
  let reads = 0
  for (const name of LIST_GETTERS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    const read = descriptor?.get
    if (descriptor === undefined || read === undefined) throw new Error(`no ${name} getter`)
    originals.set(name, descriptor)
    Object.defineProperty(prototype, name, {
      ...descriptor,
      get(this: Node) {
        const children = read.call(this) as unknown[]
        if (STATEMENT_LISTS.has(this.type)) reads += children.length
        return children
      },
    })
  }
  for (const name of CHILD_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    const method: unknown = descriptor?.value
    if (descriptor === undefined || typeof method !== "function") {
      throw new Error(`no ${name} method`)
    }
    originals.set(name, descriptor)
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(this: Node, index: number): unknown {
        if (STATEMENT_LISTS.has(this.type)) reads += 1
        return method.call(this, index)
      },
    })
  }
  try {
    await walksOf(source)
  } finally {
    for (const [name, descriptor] of originals) Object.defineProperty(prototype, name, descriptor)
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

const FEW = 10
const MANY = 400

describe("a file of many namespaces", () => {
  it.each([
    ["at the top level", topLevel],
    ["inside one outer namespace", nested],
  ])("reads statement lists in proportion to the file %s", async (_, shape) => {
    const few = await childrenRead(shape(FEW))
    const many = await childrenRead(shape(MANY))
    // Between linear and quadratic growth on purpose, so the guard is neither tight nor blind.
    expect(many).toBeLessThan(few * (MANY / FEW) * 2)
  })
})
