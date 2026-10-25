import { describe, expect, it } from "vitest"
import { hintOf, idsOf, symbolOf, walksOf } from "./fixtures/ctx"

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

/** Each Symbol as its kind, visibility and the calls its walk found, keyed by its name. */
async function readingOf(source: string) {
  const [walks, ids] = [await walksOf(source), await idsOf(source)]
  return Promise.all(
    ids.map(async (id) => {
      const symbol = await symbolOf(source, id)
      const calls = walks.get(id)?.calls.map((c) => c.target)
      return [symbol.name, symbol.kind, symbol.visibility, calls]
    }),
  )
}

describe("a class a binding holds is the class it declares", () => {
  it.each([
    ["written plainly", "export const Registry = class {"],
    ["in parentheses", "export const Registry = (class {"],
    ["with a name of its own", "export const Registry = class Inner {"],
    ["with `let`", "export let Registry = class {"],
    ["with `var`", "export var Registry = class {"],
  ])("reads one %s as `class Registry`", async (_label, head) => {
    const close = head.includes("(") ? [...MEMBERS.slice(0, -1), "})"] : MEMBERS
    const held = [head, ...close].join("\n")

    expect(await readingOf(held)).toEqual(await readingOf(DECLARED))
  })

  it.each([
    ["`as`", "export const Registry = class {\n  m() { run() }\n} as Ctor"],
    ["`satisfies`", "export const Registry = class {\n  m() { run() }\n} satisfies Ctor"],
    ["`!`", "export const Registry = class {\n  m() { run() }\n}!"],
  ])("reads through %s", async (_label, source) => {
    expect(await readingOf(source)).toEqual([
      ["Registry", "class", "public", []],
      ["Registry.m", "method", "public", ["run"]],
    ])
  })

  it("names it by the binding and records why", async () => {
    const symbol = await symbolOf(
      "export const Registry = class Inner { m() {} }",
      "ts:src/a.ts#Registry",
    )

    expect(symbol.derivedBy).toEqual(["variable-assigned-class", "export-keyword"])
    expect(await idsOf("export const Registry = class Inner { m() {} }")).toEqual([
      "ts:src/a.ts#Registry",
      "ts:src/a.ts#Registry.m",
    ])
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
})

describe("a class no binding holds directly is not one", () => {
  it("leaves a class handed to a call a const", async () => {
    const source = "export const A = mixin(class { m() { run() } })"

    expect(await readingOf(source)).toEqual([["A", "const", "public", []]])
  })

  it("leaves a class held inside a function to the function's walk", async () => {
    const source = "export function f() {\n  const A = class { m() { run() } }\n}"

    expect(await readingOf(source)).toEqual([["f", "function", "public", ["run"]]])
  })
})
