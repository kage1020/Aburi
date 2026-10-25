import { describe, expect, it } from "vitest"
import {
  findReturnedJsxElementName,
  findReturnedJsxElementNames,
  hasJsxReturn,
  isProviderElementName,
} from "../src/index"
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

describe("findReturnedJsxElementNames", () => {
  it.each([
    ["a self-closing element", "function C() { return <Widget /> }", ["Widget"]],
    [
      "a namespaced element",
      "function C() { return <MyContext.Provider>x</MyContext.Provider> }",
      ["MyContext.Provider"],
    ],
    [
      "an arrow whose body is the element",
      "const C = () => <Ctx.Provider value={1} />",
      ["Ctx.Provider"],
    ],
    [
      "an arrow whose body is the element in parentheses",
      "const C = () => (\n  <Ctx.Provider value={1} />\n)",
      ["Ctx.Provider"],
    ],
    [
      "the returned element, past a JSX helper above the return",
      "function C({ children }) { const badge = <div /> ; return <Ctx.Provider>{children}</Ctx.Provider> }",
      ["Ctx.Provider"],
    ],
    [
      "every return, past a guard that returns an element",
      "function C({ user }) { if (!user) return <Spinner /> ; return <Ctx.Provider value={user} /> }",
      ["Spinner", "Ctx.Provider"],
    ],
    [
      "the element past a guard that returns null",
      "function C({ user }) { if (!user) return null ; return <Ctx.Provider value={user} /> }",
      ["Ctx.Provider"],
    ],
    [
      "a returned element in parentheses",
      "function C() { return (\n  <Ctx.Provider value={1} />\n) }",
      ["Ctx.Provider"],
    ],
    [
      "a returned element behind as, satisfies and a comment",
      "function C() { return (/* ready */ <Ctx.Provider value={1} /> as JSX.Element) satisfies object }",
      ["Ctx.Provider"],
    ],
    [
      "both arms of a conditional",
      "function C({ user }) { return user ? <Ctx.Provider value={user} /> : <Spinner /> }",
      ["Ctx.Provider", "Spinner"],
    ],
    [
      "only the last operand of &&, since an element before it is never falsy",
      "function C({ user }) { return user && <Spinner /> && <Ctx.Provider value={user} /> }",
      ["Ctx.Provider"],
    ],
    [
      "both sides of ?? and ||",
      "function C({ a, b }) { return (a ?? <First />) || <Second /> }",
      ["First", "Second"],
    ],
    [
      "the outer element, not a provider inside it",
      "function C() { return <Boundary><Ctx.Provider value={1} /></Boundary> }",
      ["Boundary"],
    ],
    [
      "no name for a fragment, nor for a provider inside it",
      "function C() { return <><Ctx.Provider value={1} /></> }",
      [],
    ],
    ["no JSX", "function C() { return 1 }", []],
    [
      "nothing for a returned call, whatever its callback returns",
      "function C({ items }) { return items.map((item) => <Ctx.Provider value={item} />) }",
      [],
    ],
    [
      "nothing for elements in a returned array",
      "function C() { return [<Ctx.Provider key={1} value={1} />] }",
      [],
    ],
    [
      "nothing for JSX returned only by a nested arrow",
      "function C() { const cb = () => <div /> ; return null }",
      [],
    ],
    [
      "nothing for a return inside a nested function, generator, arrow or method",
      "function C() { function a() { return <A.Provider /> } ; const b = function* () { return <B.Provider /> } ; class K { m() { return <K.Provider /> } } ; const r = (i) => { return <R.Provider value={i} /> } ; const e = function () { return <E.Provider /> } ; function* g() { return <G.Provider /> } ; return <div /> }",
      ["div"],
    ],
  ])("reads %s", async (_label, source, names) => {
    expect(findReturnedJsxElementNames(await bodyOf(source))).toEqual(names)
  })

  it.each([
    null,
    { placeholder: true },
  ])("returns no names for %o, which is not a syntax node", (body) => {
    expect(findReturnedJsxElementNames(body)).toEqual([])
  })
})

describe("findReturnedJsxElementName", () => {
  it.each([
    [
      "the first of several returned elements",
      "function C({ user }) { if (!user) return <Spinner /> ; return <Ctx.Provider value={user} /> }",
      "Spinner",
    ],
    ["a fragment, which has no name", "function C() { return <>x</> }", null],
    ["no JSX", "function C() { return 1 }", null],
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
