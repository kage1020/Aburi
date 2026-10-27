import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { callsOf, hintOf, idsOf, normalizedOf, symbolOf, walksOf } from "./fixtures/ctx"
import { scanWithoutWarnings } from "./fixtures/scan"

const MEMBERS = [
  "  seed = load()",
  "  static {",
  "    purge()",
  "  }",
  "  reset() {",
  "    create()",
  "  }",
  "  static make() {",
  "    build()",
  "  }",
  "}",
]

const DECLARED = ["export class Registry {", ...MEMBERS].join("\n")

/**
 * Each Symbol as its name, kind, visibility, the targets its walk called and its normalized AST,
 * in extraction order.
 */
async function readingOf(source: string) {
  const [walks, ids] = [await walksOf(source), await idsOf(source)]
  return Promise.all(
    ids.map(async (id) => {
      const symbol = await symbolOf(source, id)
      const calls = walks.get(id)?.calls.map((c) => c.target)
      return [symbol.name, symbol.kind, symbol.visibility, calls, await normalizedOf(source, id)]
    }),
  )
}

/** `readingOf` without the normalized AST, for a row that spells its expected reading out. */
async function shapeOf(source: string) {
  return (await readingOf(source)).map((reading) => reading.slice(0, 4))
}

describe("a class a binding holds is the class it declares", () => {
  it.each([
    ["written plainly", "export const Registry = class {", "}"],
    ["in parentheses", "export const Registry = (class {", "})"],
    ["with a name of its own", "export const Registry = class Inner {", "}"],
    ["with `let`", "export let Registry = class {", "}"],
    ["with `var`", "export var Registry = class {", "}"],
  ])("reads one %s as `class Registry`", async (_label, head, close) => {
    const held = [head, ...MEMBERS.slice(0, -1), close].join("\n")

    expect(await readingOf(held)).toEqual(await readingOf(DECLARED))
  })

  it.each([
    [
      "a type-only namespace merged with it",
      "export namespace X {\n  export type O = {}\n}",
      "{ m() {} }",
    ],
    [
      "a namespace interface named as one of its methods",
      "export namespace X {\n  export interface O { k: 1 }\n}",
      "{ O() { a() } }",
    ],
  ])("gives %s the static side a declared class gives it", async (_label, namespace, body) => {
    const held = `export const X = class ${body}\n${namespace}`
    const declared = `export class X ${body}\n${namespace}`

    expect(await readingOf(held)).toEqual(await readingOf(declared))
  })

  it.each([
    ["`as`", "export const Registry = class {\n  m() { run() }\n} as Ctor"],
    ["`satisfies`", "export const Registry = class {\n  m() { run() }\n} satisfies Ctor"],
    ["`!`", "export const Registry = class {\n  m() { run() }\n}!"],
  ])("reads through %s", async (_label, source) => {
    expect(await shapeOf(source)).toEqual([
      ["Registry", "class", "public", []],
      ["Registry.m", "method", "public", ["run"]],
    ])
  })

  it("reads a field handing a function to a call as its member, with the call left on the class", async () => {
    const source = "export const K = class {\n  handle = withAuth(() => { check() })\n}"

    expect(await shapeOf(source)).toEqual([
      ["K", "class", "public", ["withAuth"]],
      ["K.handle", "method", "public", ["check"]],
    ])
  })

  it("names it by the binding and records why", async () => {
    const symbol = await symbolOf(
      "export const Registry = class Inner { m() {} }",
      "ts:src/a.ts#Registry",
    )

    expect(symbol.derivedBy).toEqual(["variable-assigned-class", "export-keyword"])
  })

  it.each([
    ["with no export", "const R = class { m() {} }", "internal", ["variable-assigned-class"]],
    [
      "exported by a later clause",
      "const R = class { m() {} }\nexport { R }",
      "public",
      ["variable-assigned-class", "export-clause:R"],
    ],
  ])("reads a binding %s as the declared class reads", async (_label, source, visibility, derivedBy) => {
    expect(await symbolOf(source, "ts:src/a.ts#R")).toMatchObject({ visibility, derivedBy })
  })

  it("spans the statement, from the binding's line", async () => {
    const symbol = await symbolOf("export const R =\n  class {\n    m() {}\n  }", "ts:src/a.ts#R")

    expect(symbol.source).toMatchObject({ startLine: 1, endLine: 4 })
  })

  it("reads the decorators written on the class", async () => {
    const symbol = await symbolOf("export const A = @dec class { x = 0 }", "ts:src/a.ts#A")

    expect(symbol.decorators.map((d) => d.name)).toEqual(["dec"])
  })

  it("nests it under the namespace the binding is written in", async () => {
    expect(await idsOf("export namespace N {\n  export const A = class { m() {} }\n}")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.A",
      "ts:src/a.ts#N.A.m",
    ])
  })

  it.each([
    ["fields alone", "export const P = class { x = 0; y = 0 }", "pure DTO"],
    [
      "static readonly literals",
      "export const P = class { static readonly MAX = 1 }",
      "pure constants",
    ],
  ])("hints a class of %s as data, as it hints the declaration", async (_label, source, reason) => {
    expect(await hintOf(source, "ts:src/a.ts#P")).toEqual({ reason, category: "B" })
  })

  it("keeps a class of fields and a static block, whose calls its walk carries", async () => {
    const source = "export const P = class { x = 0; static { boot() } }"

    expect(await hintOf(source, "ts:src/a.ts#P")).toBeNull()
    expect(await callsOf(source, "ts:src/a.ts#P")).toEqual(["boot"])
  })
})

describe("a call into a class a binding holds", () => {
  const workspace = useScratchWorkspace("held-class")

  it("resolves to its member, in its own file and through an import", async () => {
    await workspace.writeSource(
      "src/a.ts",
      [
        "export const Registry = class {",
        "  static make() {",
        "    build()",
        "  }",
        "}",
        "",
        "export function use() {",
        "  Registry.make()",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/b.ts",
      'import { Registry } from "./a"\n\nexport function other() {\n  Registry.make()\n}\n',
    )

    const ir = await scanWithoutWarnings(workspace.root)

    for (const caller of ["ts:src/a.ts#use", "ts:src/b.ts#other"]) {
      expect(symbolById({ ir }, caller).calls.map((c) => c.resolved)).toEqual([
        "ts:src/a.ts#Registry::make",
      ])
    }
  })
})

describe("a class no binding holds directly is not one", () => {
  it("leaves a class handed to a call a const", async () => {
    const source = "export const A = mixin(class { m() { run() } })"

    expect(await shapeOf(source)).toEqual([["A", "const", "public", []]])
  })

  it("leaves a class held inside a function to the function's walk", async () => {
    const source = "export function f() {\n  const A = class { m() { run() } }\n}"

    expect(await shapeOf(source)).toEqual([["f", "function", "public", ["run"]]])
  })
})
