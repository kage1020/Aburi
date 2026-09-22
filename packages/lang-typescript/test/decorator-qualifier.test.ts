import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

/**
 * The receiver a decorator was written through, which `Decorator.qualifier` carries.
 *
 * `@nest.Controller()` and `@tsed.Controller()` both name `Controller`, and the leaf alone is
 * all a framework plugin used to get. A namespace import binds the module object rather than
 * any name on it, so nothing tied the leaf back to its module and a decorator from a
 * competing library was classified — at high confidence — on the strength of its spelling.
 *
 * What is carried is the whole receiver as written, not its first segment: the IR quotes
 * source, and a consumer resolving a namespace binding takes the first segment itself.
 */

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
    // Class B (ir-schema.md §1.1): absent, not null and not "". A writer that emitted the key
    // anyway would make every decorator in every Document carry it.
    const decorators = await decoratorsOf(
      ["@Controller()", "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("Controller")
  })

  it("reads the receiver of a decorator written without arguments", async () => {
    // `@ns.Injectable` is a member expression rather than a call, and the qualifier is read
    // off the same node the leaf is.
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
  ])("has nothing to carry where the grammar accepts no decorator at all (%s)", async (_label, written) => {
    // The reason there is no test on the shape of a receiver: these are the forms that are
    // not a path, and the grammar rejects each outright rather than handing one over with a
    // receiver that names nothing. The class comes back undecorated.
    const decorators = await decoratorsOf([written, "export class C {}", ""].join("\n"), "#C")
    expect(decorators).toEqual([])
  })

  it("quotes a receiver that is written but names no import, rather than dropping it", async () => {
    // `this` and an optional chain do reach here. Neither names an import edge, so a consumer
    // resolving them finds nothing and falls back on the leaf — the same answer as before.
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
