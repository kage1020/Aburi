import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

describe("a parameter default is walked with the body it belongs to", () => {
  it.each([
    ["a function", "export function f(x = g()) { h() }", ["g", "h"]],
    ["an arrow", "export const a = (y = k()) => l()", ["k", "l"]],
    ["a function expression", "export const e = function (y = k()) { l() }", ["k", "l"]],
    ["a destructured parameter", "export function d({ a = mk() } = dflt()) {}", ["mk", "dflt"]],
    ["an inline handler", "app.get('/x', (req = dflt()) => handle())", ["dflt", "handle"]],
    ["an arrow whose parameter has no parentheses", "export const f = x => g(x)", ["g"]],
  ])("in %s", async (_label, source, expected) => {
    expect((await walkFirstSymbol(source)).calls.map((c) => c.target)).toEqual(expected)
  })

  it("gives a default's call the default's own line", async () => {
    const { calls } = await walkFirstSymbol("export function f(\n  x = g(),\n) {\n  h()\n}")

    expect(calls.map((c) => [c.target, c.line])).toEqual([
      ["g", 2],
      ["h", 4],
    ])
  })

  it("takes a default's rules as well as its calls", async () => {
    const { rules, calls } = await walkFirstSymbol(
      "export function f(cb = () => { throw new E() }) { h() }",
    )

    expect(rules.map((r) => r.type)).toEqual(["throw"])
    expect(calls.map((c) => c.target)).toEqual(["E", "h"])
  })
})
