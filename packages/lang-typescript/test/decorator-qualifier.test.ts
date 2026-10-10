import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

const decoratorsOf = async (source: string, id: string) =>
  byId(await symbolsOf(source), id).decorators

const onClass = (...decorators: string[]) => [...decorators, "export class C {}", ""].join("\n")

const onMethod = (decorator: string) =>
  ["export class C {", `  ${decorator}`, "  list() {}", "}", ""].join("\n")

describe("what a decorator reads as", () => {
  it.each([
    [
      "a qualified call",
      '@nest.Controller("/x")',
      { name: "Controller", qualifier: "nest", raw: 'nest.Controller("/x")', arguments: ['"/x"'] },
    ],
    [
      "a bare call, with no qualifier key at all",
      '@Controller("/x")',
      { name: "Controller", raw: 'Controller("/x")', arguments: ['"/x"'] },
    ],
    [
      "a qualified name written without arguments",
      "@ns.Injectable",
      { name: "Injectable", qualifier: "ns", raw: "ns.Injectable", arguments: [] },
    ],
    [
      "a bare name written without arguments",
      "@Post",
      { name: "Post", raw: "Post", arguments: [] },
    ],
    [
      "a nested receiver, carried whole for the consumer to take its first segment",
      "@a.b.C()",
      { name: "C", qualifier: "a.b", raw: "a.b.C()", arguments: [] },
    ],
    [
      "an optional chain's receiver, which names no import but is written",
      "@a?.Get()",
      { name: "Get", qualifier: "a", raw: "a?.Get()", arguments: [] },
    ],
  ])("reads %s", async (_label, written, expected) => {
    expect(await decoratorsOf(onClass(written), "#C")).toStrictEqual([
      { ...expected, boundary: false, line: 1 },
    ])
  })

  it.each([
    ["@this.Get()", "this"],
    ["@nest.Get()", "nest"],
  ])("reads the receiver of %s on a method as it does on a class", async (written, qualifier) => {
    expect((await decoratorsOf(onMethod(written), "#C.list"))[0]?.qualifier).toBe(qualifier)
  })

  it.each([
    ["a subscript", "@arr[0].Controller()"],
    ["a parenthesized receiver", "@(a).Controller()"],
    ["a call", "@pick().Controller()"],
    ["a computed member", '@ns["Controller"]()'],
  ])("has nothing to carry where the decorator never reaches the run (%s)", async (_label, written) => {
    expect(await decoratorsOf(onClass(written), "#C")).toEqual([])
  })

  it("keeps the qualifier on every decorator of a run, in source order", async () => {
    const decorators = await decoratorsOf(
      onClass("@nest.UseGuards(G)", "@Controller()", "@other.Injectable()"),
      "#C",
    )

    expect(decorators.map((d) => [d.name, d.qualifier])).toEqual([
      ["UseGuards", "nest"],
      ["Controller", undefined],
      ["Injectable", "other"],
    ])
  })
})
