import { UNNAMED_DECORATOR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { byId, importsOf, symbolsOf } from "./fixtures/ctx"

const decoratorsOf = async (source: string) =>
  byId(await symbolsOf([source, "export class C {}", ""].join("\n")), "#C").decorators

const errorsOf = async (source: string) =>
  (await importsOf([source, "export class C {}", ""].join("\n"))).errors.length

describe("a decorator written in parentheses", () => {
  it("imports the marker from a built @aburi/types", () => {
    expect(UNNAMED_DECORATOR).toBe("<expression>")
  })

  it("LP14g: reads a name through them, and quotes them in raw", async () => {
    expect(await errorsOf("@(Controller)")).toBe(0)
    expect(await decoratorsOf("@(Controller)")).toStrictEqual([
      { name: "Controller", raw: "(Controller)", arguments: [], boundary: false, line: 1 },
    ])
  })

  it("LP14g: reads a member path through them, receiver and all", async () => {
    expect(await decoratorsOf("@(nest.Controller)")).toStrictEqual([
      {
        name: "Controller",
        qualifier: "nest",
        raw: "(nest.Controller)",
        arguments: [],
        boundary: false,
        line: 1,
      },
    ])
  })

  it("LP14g: keeps a line break inside the parentheses out of the name", async () => {
    const [decorator] = await decoratorsOf("@(nest\n  .Controller)")
    expect(decorator?.name).toBe("Controller")
    expect(decorator?.qualifier).toBe("nest")
    expect(decorator?.raw).toBe("(nest\n  .Controller)")
  })

  it("LP14g: reads a call through them, arguments included", async () => {
    expect(await errorsOf("@(Controller('/x'))")).toBe(0)
    const [decorator] = await decoratorsOf("@(Controller('/x'))")
    expect(decorator?.name).toBe("Controller")
    expect(decorator?.arguments).toEqual(["'/x'"])
    expect(decorator?.raw).toBe("(Controller('/x'))")
  })

  it("LP14g: keeps the name when only an argument is broken, as the unparenthesized form does", async () => {
    for (const written of ["@(Controller(a b))", "@Controller(a b)"]) {
      expect(await errorsOf(written)).toBeGreaterThan(0)
      const [decorator] = await decoratorsOf(written)
      expect(decorator?.name).toBe("Controller")
      expect(decorator?.arguments).toEqual(["a", "b"])
    }
    const [qualified] = await decoratorsOf("@(nest.Controller(a b))")
    expect(qualified?.name).toBe("Controller")
    expect(qualified?.qualifier).toBe("nest")
  })

  it("LP14g: skips a comment inside the parentheses", async () => {
    expect((await decoratorsOf("@(/* why */ Controller)"))[0]?.name).toBe("Controller")
  })

  it.each([
    ["an assertion", "@(x as any)"],
    ["a non-null assertion", "@(x!)"],
    ["an element access", "@(a[b])"],
    ["an instantiation expression", "@(C<T>)"],
    ["a construction", "@(new C())"],
    ["a sequence", "@(a, b)"],
    ["a member of a call", "@(pick().C)"],
    ["an optional chain", "@(a?.C)"],
    ["a path missing its property", "@(nest.)"],
  ])("LP14h: gives %s, which the grammar had to repair, no name", async (_label, written) => {
    expect(await errorsOf(written)).toBeGreaterThan(0)
    expect(await decoratorsOf(written)).toStrictEqual([
      {
        name: UNNAMED_DECORATOR,
        raw: written.slice(1),
        arguments: [],
        boundary: false,
        line: 1,
      },
    ])
  })
})
