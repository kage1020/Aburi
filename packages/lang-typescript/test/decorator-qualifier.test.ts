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
  it("LP14a: carries the receiver of a qualified decorator", async () => {
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

  it("LP14b: omits the key entirely on a bare decorator", async () => {
    // Class B (ir-schema.md §1.1): absent, not null and not "". A writer that emitted the key
    // anyway would make every decorator in every Document carry it.
    const decorators = await decoratorsOf(
      ["@Controller()", "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("Controller")
  })

  it("LP14a: reads the receiver of a decorator written without arguments", async () => {
    // `@ns.Injectable` is a member expression rather than a call, and the qualifier is read
    // off the same node the leaf is.
    const decorators = await decoratorsOf(
      ["@ns.Injectable", "export class C {}", ""].join("\n"),
      "#C",
    )
    expect(decorators[0]?.qualifier).toBe("ns")
    expect(decorators[0]?.name).toBe("Injectable")
  })

  it("LP14c: carries a nested receiver whole, leaving the consumer to take its first segment", async () => {
    const decorators = await decoratorsOf(["@a.b.C()", "export class D {}", ""].join("\n"), "#D")
    expect(decorators[0]?.qualifier).toBe("a.b")
    expect(decorators[0]?.name).toBe("C")
  })

  it.each([
    ["a subscript", "@arr[0].Controller()"],
    ["a parenthesized receiver", "@(a).Controller()"],
    ["a call", "@pick().Controller()"],
    ["a computed member", '@ns["Controller"]()'],
  ])("LP14d: has nothing to carry where the decorator never reaches the run (%s)", async (_label, written) => {
    // Not a grammar rejection, though it is easy to read as one. Each of these parses as a
    // decorator of the leading fragment the grammar could take — `@arr`, `@(a)`, `@pick()`,
    // `@ns` — wrapped in an ERROR node that leaves it no longer a preceding sibling of the
    // declaration, which is what `collectDecoratorNodes` walks. The class comes back
    // undecorated, so there is nothing to qualify, but by where recovery put the node.
    const decorators = await decoratorsOf([written, "export class C {}", ""].join("\n"), "#C")
    expect(decorators).toEqual([])
  })

  it("LP14f: reports no qualifier for a receiver that is not a member expression", async () => {
    // `@(a.b)` parses cleanly — a parenthesized expression is a legal decorator — and reaches
    // the extractor, where `leafIdentifier` falls back to the node's text. So the grammar
    // admits more than a name, a dotted run and a call, and the rule about what carries a
    // qualifier is the extractor's own: a member expression with an object, and nothing else.
    const decorators = await decoratorsOf(["@(a.b)", "export class C {}", ""].join("\n"), "#C")
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("(a.b)")
  })

  it("LP14b: omits the key on a bare decorator written without arguments", async () => {
    // The second of the two paths through `readDecorator`: `@Post` is neither a call nor a
    // member expression, so the bare-form spread has to omit the key as the call form does.
    const decorators = await decoratorsOf(["@Post", "export class C {}", ""].join("\n"), "#C")
    expect(decorators[0]).not.toHaveProperty("qualifier")
    expect(decorators[0]?.name).toBe("Post")
  })

  it("LP14e: quotes a receiver that is written but names no import, rather than dropping it", async () => {
    // `this` and an optional chain do reach here. `@this.C()` parses cleanly; `@a?.C()` does
    // not — the `?` lands in an ERROR child of a recovered member expression, whose object
    // field still reads `a`. Neither names an import edge, so a consumer resolving them finds
    // nothing and falls back on the leaf — the same answer as before.
    const viaThis = await decoratorsOf(
      ["export class C {", "  @this.Get()", "  list() {}", "}", ""].join("\n"),
      "#C.list",
    )
    expect(viaThis[0]?.qualifier).toBe("this")

    const optional = await decoratorsOf(["@a?.Get()", "export class D {}", ""].join("\n"), "#D")
    expect(optional[0]?.qualifier).toBe("a")
    expect(optional[0]?.raw).toBe("a?.Get()")
  })

  it("LP15: keeps the qualifier on every decorator of a run, in source order", async () => {
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

  it("LP14a: reads one on a decorated method as it does on a class", async () => {
    const decorators = await decoratorsOf(
      ["export class C {", "  @nest.Get()", "  list() {}", "}", ""].join("\n"),
      "#C.list",
    )
    expect(decorators[0]?.qualifier).toBe("nest")
  })
})
