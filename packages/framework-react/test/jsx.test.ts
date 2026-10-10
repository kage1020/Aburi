import { describe, expect, it } from "vitest"
import { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "../src/index"
import { candidateNamed } from "./fixtures/symbol"

async function bodyOf(source: string): Promise<unknown> {
  return (await candidateNamed(source, "C")).bodyNode
}

describe("hasJsxReturn", () => {
  it.each([
    ["an element", true, "function C() { return <div>hi</div> }"],
    ["a self-closing element", true, "function C() { return <br /> }"],
    ["a fragment", true, "function C() { return <>hi</> }"],
    ["JSX inside a conditional", true, "function C(x) { if (x) return <p /> ; return null }"],
    ["a literal", false, "function C() { return 42 }"],
  ])("reads a body returning %s as JSX: %s", async (_label, expected, source) => {
    expect(hasJsxReturn(await bodyOf(source))).toBe(expected)
  })

  it.each([
    null,
    { placeholder: true },
  ])("returns false for %o, which is not a syntax node", (body) => {
    expect(hasJsxReturn(body)).toBe(false)
  })
})

describe("findReturnedJsxElementName", () => {
  it.each([
    ["a self-closing element", "function C() { return <Widget /> }", "Widget"],
    [
      "a namespaced element",
      "function C() { return <MyContext.Provider>x</MyContext.Provider> }",
      "MyContext.Provider",
    ],
    [
      "an arrow whose body is the element",
      "const C = () => <Ctx.Provider value={1} />",
      "Ctx.Provider",
    ],
    [
      "the returned element, past a JSX helper above the return",
      "function C({ children }) { const badge = <div /> ; return <Ctx.Provider>{children}</Ctx.Provider> }",
      "Ctx.Provider",
    ],
    ["a fragment, which has no name", "function C() { return <>x</> }", null],
    ["no JSX", "function C() { return 1 }", null],
    [
      "JSX returned only by a nested function",
      "function C() { const cb = () => <div /> ; return null }",
      null,
    ],
  ])("reads %s", async (_label, source, name) => {
    expect(findReturnedJsxElementName(await bodyOf(source))).toBe(name)
  })
})

describe("isProviderElementName", () => {
  it.each([
    ["MyContext.Provider", true],
    ["foo.bar.Provider", true],
    ["Provider", false],
    ["MyContext.Consumer", false],
    ["div", false],
    ["", false],
    [null, false],
  ])("reads %j as a context provider: %s", (name, expected) => {
    expect(isProviderElementName(name)).toBe(expected)
  })
})
