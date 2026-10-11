import { describe, expect, it } from "vitest"
import { idsOf, symbolOf } from "./fixtures/ctx"

describe("an unexported namespace is a declaration, not an expression", () => {
  it.each([
    ["a lone one", "namespace N { export const a = 1 }\n", ["ts:src/a.ts#N", "ts:src/a.ts#N.a"]],
    [
      "two of one name, with both bodies' members",
      "namespace N { export const a = 1 }\nnamespace N { export const b = 2 }\n",
      ["ts:src/a.ts#N", "ts:src/a.ts#N.a", "ts:src/a.ts#N.b"],
    ],
    [
      "the `module` spelling",
      "module N { export const a = 1 }\n",
      ["ts:src/a.ts#N", "ts:src/a.ts#N.a"],
    ],
    [
      "one nested inside another",
      "export namespace Outer {\n  namespace Inner { export const a = 1 }\n}",
      ["ts:src/a.ts#Outer", "ts:src/a.ts#Outer.Inner", "ts:src/a.ts#Outer.Inner.a"],
    ],
  ])("declares %s", async (_label, source, ids) => {
    expect(await idsOf(source)).toEqual(ids)
  })
})

describe("a dotted namespace declares each of its segments", () => {
  it.each([
    ["unexported", "namespace A.B { export const x = 1 }"],
    ["exported", "export namespace A.B { export const x = 1 }"],
    ["the module spelling", "module A.B { export const x = 1 }"],
  ])("declares the head, the tail and the body — %s", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.B", "ts:src/a.ts#A.B.x"])
  })

  it("declares three segments for a three-part name", async () => {
    expect(await idsOf("export namespace My.App.Utils {}")).toEqual([
      "ts:src/a.ts#My",
      "ts:src/a.ts#My.App",
      "ts:src/a.ts#My.App.Utils",
    ])
  })

  it("gives two dotted declarations under one head a single head Symbol", async () => {
    const source = ["export namespace A.B {}", "export namespace A.C {}"].join("\n")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.B", "ts:src/a.ts#A.C"])
    expect((await symbolOf(source, "ts:src/a.ts#A")).derivedBy).toContain("declaration-merged")
  })
})
