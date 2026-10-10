import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

const decoratorsOf = async (source: string, id: string) =>
  byId(await symbolsOf(source), id).decorators

describe("Decorator.qualifier", () => {
  it("carries the receiver of a qualified decorator", async () => {
    const decorators = await decoratorsOf(
      ['@nest.Controller("/x")', "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators).toEqual([
      {
        name: "Controller",
        qualifier: "nest",
        raw: 'nest.Controller("/x")',
        arguments: ['"/x"'],
        boundary: false,
        line: 1,
      },
    ])
  })

  it("omits the key entirely on a bare decorator", async () => {
    const decorators = await decoratorsOf(
      ["@Controller()", "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("Controller")
  })

  it("reads the receiver of a decorator written without arguments", async () => {
    const decorators = await decoratorsOf(
      ["@ns.Injectable", "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators[0]?.qualifier).toBe("ns")
    expect(decorators[0]?.name).toBe("Injectable")
  })

  it("carries a nested receiver whole, leaving the consumer to take its first segment", async () => {
    const decorators = await decoratorsOf(["@a.b.C()", "export class D {}", ""].join("\n"), "#D")
    expect(decorators[0]?.qualifier).toBe("a.b")
    expect(decorators[0]?.name).toBe("C")
  })

  it.each([
    ["a subscript", "@arr[0].Controller()"],
    ["a parenthesized receiver", "@(a).Controller()"],
    ["a call", "@pick().Controller()"],
    ["a computed member", '@ns["Controller"]()'],
  ])("has nothing to carry where the decorator never reaches the run (%s)", async (_label, written) => {
    const decorators = await decoratorsOf([written, "export class C {}", ""].join("\n"), "#C")
    expect(decorators).toEqual([])
  })

  it("reads the receiver through the parentheses it was written in", async () => {
    const decorators = await decoratorsOf(["@(a.b)", "export class C {}", ""].join("\n"), "#C")
    expect(decorators[0]?.qualifier).toBe("a")
    expect(decorators[0]?.name).toBe("b")
  })

  it("omits the key on a bare decorator written without arguments", async () => {
    const decorators = await decoratorsOf(["@Post", "export class C {}", ""].join("\n"), "#C")
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("Post")
  })

  it("quotes a receiver that is written but names no import, rather than dropping it", async () => {
    const viaThis = await decoratorsOf(
      ["export class C {", "  @this.Get()", "  list() {}", "}", ""].join("\n"),
      "#C.list",
    )
    expect(viaThis[0]?.qualifier).toBe("this")

    const optional = await decoratorsOf(["@a?.Get()", "export class D {}", ""].join("\n"), "#D")
    expect(optional[0]?.qualifier).toBe("a")
    expect(optional[0]?.raw).toBe("a?.Get()")
  })

  it("keeps the qualifier on every decorator of a run, in source order", async () => {
    const decorators = await decoratorsOf(
      ["@nest.UseGuards(G)", "@Controller()", "@other.Injectable()", "export class C {}", ""].join(
        "\n",
      ),
      "#C",
    )
    expect(decorators.map((d) => [d.name, d.qualifier])).toEqual([
      ["UseGuards", "nest"],
      ["Controller", undefined],
      ["Injectable", "other"],
    ])
  })

  it("reads one on a decorated method as it does on a class", async () => {
    const decorators = await decoratorsOf(
      ["export class C {", "  @nest.Get()", "  list() {}", "}", ""].join("\n"),
      "#C.list",
    )
    expect(decorators[0]?.qualifier).toBe("nest")
  })
})
