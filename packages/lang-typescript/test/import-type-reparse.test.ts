import type { WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { walkDescendants } from "../src/ast-helpers"
import { walkBody } from "../src/walk-body"
import { makeExtractionCtx, parseSource, requireTree, symbolsOf } from "./fixtures/ctx"

/**
 * LP27b — an `import("…")` type the grammar cannot place is read through a second parse that
 * replaces it with a same-length name, and the tree still reads the original text.
 */

async function errorsOf(source: string): Promise<string[]> {
  const result = await parseSource(source)
  return result.errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

async function textsOf(source: string, type: string): Promise<string[]> {
  const tree = requireTree((await parseSource(source)).tree)
  return [...walkDescendants(tree.rootNode)].filter((n) => n.type === type).map((n) => n.text)
}

async function callsOf(source: string, name: string): Promise<string[]> {
  const target = (await symbolsOf(source)).find((s) => s.name === name)
  if (target === undefined) throw new Error(`no Symbol ${name} in fixture`)
  const walkCtx: WalkContext<Node> = { ...makeExtractionCtx("src/a.ts", source), symbol: target }
  return walkBody(target, walkCtx).calls.map((c) => c.target)
}

const VI_MOCK = [
  'import { vi } from "vitest"',
  'vi.mock("./search", async (importActual) => ({',
  '  ...(await importActual<typeof import("./search")>()),',
  "  searchRegistries: vi.fn(() => []),",
  "}))",
  "export function after() {",
  "  other()",
  "}",
  "",
].join("\n")

describe("LP27b — an import() type the grammar cannot place", () => {
  it.each([
    ["first in a call's type arguments", 'export const b = g<typeof import("./m")>()'],
    ["qualified, in a call's type arguments", 'export const f2 = g<import("./m").T>()'],
    ["after await", 'export const c = await g<typeof import("./m")>()'],
    ["spread from an await", 'export const d = { ...(await g<typeof import("./m")>()) }'],
    ["before [] in an annotation", 'let y: import("./m").T[] = []'],
    ["before [] in an interface", 'interface I { r: import("./m").Rule[] }'],
    ["indexed", 'export const e = g<typeof import("./m")["x"]>()'],
    ["the vitest mocking idiom", VI_MOCK],
  ])("parses clean when %s", async (_label, source) => {
    expect(await errorsOf(source)).toEqual([])
  })

  it("reads the original text, not the mask", async () => {
    const source = 'export const b = g<typeof import("./m")>()\nlet y: import("./m").T[] = []\n'
    expect(await textsOf(source, "type_query")).toEqual(['typeof import("./m")'])
    expect(await textsOf(source, "nested_type_identifier")).toEqual(['import("./m").T'])
    const tree = requireTree((await parseSource(source)).tree)
    expect(tree.rootNode.text).toBe(source)
  })

  it("keeps the declaration after one at module level", async () => {
    const source = 'export const b = g<typeof import("./m")>()\nexport function t() { other() }\n'
    const symbols = await symbolsOf(source)
    expect(symbols.map((s) => [s.name, s.source.startLine, s.source.endLine])).toEqual([
      ["b", 1, 1],
      ["t", 2, 2],
    ])
  })

  it("finds the calls a plain type argument would, and none for the import() type", async () => {
    const load = (typeArgument: string) =>
      [
        "export async function load() {",
        `  const actual = await importActual<${typeArgument}>()`,
        "  run(actual)",
        "}",
      ].join("\n")
    const calls = await callsOf(load('typeof import("./m")'), "load")
    expect(calls).toEqual(await callsOf(load("Mod"), "load"))
    expect(calls).toContain("run")
    expect(calls).not.toContain("import")
  })

  it("leaves a dynamic import under the same error a dynamic import", async () => {
    const source = [
      "export async function load() {",
      '  const [m, a] = [await import("./x"), await importActual<typeof import("./m")>()]',
      "}",
    ].join("\n")
    const result = await parseSource(source)
    expect(result.errors).toEqual([])
    expect(result.imports.filter((e) => e.dynamic).map((e) => e.source)).toEqual(["./x"])
  })

  it("keeps the tree of an import() type that parsed, in a body broken elsewhere", async () => {
    const source = [
      'export const b = g<typeof import("./n")>()',
      "export function f() {",
      '  type T = typeof import("./m")',
      "  const x = (",
      "}",
    ].join("\n")
    const tree = requireTree((await parseSource(source)).tree)
    const queries = [...walkDescendants(tree.rootNode)].filter((n) => n.type === "type_query")
    expect(queries.map((q) => q.namedChild(0)?.type)).toEqual(["identifier", "call_expression"])
    expect(await errorsOf(source)).toHaveLength(1)
  })

  it("still reports an unrelated error in the same file", async () => {
    const source = 'export const b = g<typeof import("./m")>()\nconst x = (\n'
    const errors = await errorsOf(source)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^2:/)
  })

  it("does not mask an import() whose argument spans a line", async () => {
    const source = 'export const b = g<typeof import(\n  "./m"\n)>()\n'
    expect(await errorsOf(source)).not.toEqual([])
  })
})
