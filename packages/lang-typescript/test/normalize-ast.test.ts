import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolsOf } from "./fixtures/ctx"

async function normalizeFirstSymbol(source: string): Promise<string> {
  const [target] = await symbolsOf(source)
  if (target === undefined) throw new Error("no symbols in fixture")
  return normalizeAst(target)
}

describe("normalizeAst — S1-S5 language plugin contract", () => {
  it("S1: adding a comment inside the body leaves the normalized form unchanged", async () => {
    const withoutComment = await normalizeFirstSymbol("export function f() { return 1 }")
    const withComment = await normalizeFirstSymbol("export function f() { /* note */ return 1 }")
    expect(withoutComment).toBe(withComment)
  })

  it("S2: whitespace / indentation differences leave the normalized form unchanged", async () => {
    const flat = await normalizeFirstSymbol("export function f(){return 1}")
    const pretty = await normalizeFirstSymbol("export function f() {\n  return 1\n}")
    expect(flat).toBe(pretty)
  })

  it("S3: adding a statement changes the normalized form", async () => {
    const one = await normalizeFirstSymbol("export function f() { return 1 }")
    const two = await normalizeFirstSymbol("export function f() { const x = 0; return 1 }")
    expect(one).not.toBe(two)
  })

  it("S4: renaming an identifier changes the normalized form", async () => {
    const withX = await normalizeFirstSymbol("export function f(x: number) { return x }")
    const withY = await normalizeFirstSymbol("export function f(y: number) { return y }")
    expect(withX).not.toBe(withY)
  })

  it("S5: changing a literal value changes the normalized form", async () => {
    const one = await normalizeFirstSymbol("export function f() { return 1 }")
    const two = await normalizeFirstSymbol("export function f() { return 2 }")
    expect(one).not.toBe(two)
  })
})

/**
 * Operators, declaration keywords and modifiers are anonymous tokens or keyword leaves in
 * tree-sitter, and an edit to one is a change to what the code says. The tokens a formatter
 * adds or swaps are not.
 */
describe("normalizeAst — operators, keywords and modifiers", () => {
  const changes = (before: string, after: string) => async () => {
    const one = await normalizeFirstSymbol(before)
    const two = await normalizeFirstSymbol(after)
    expect(one).not.toBe(two)
  }
  const fn = (body: string) => `export function f(a: any, b: any, x: any, v: any) { ${body} }`

  it(
    "S6: a binary operator",
    changes(fn("const t = a + b; save(t)"), fn("const t = a - b; save(t)")),
  )
  it("S6: a logical operator", changes(fn("audit(a && b)"), fn("audit(a || b)")))
  it("S6: a comparison", changes(fn("track(x === null)"), fn("track(x !== null)")))
  it(
    "S6: a loop bound",
    changes(
      fn("for (let i = 0; i < x.length; i++) {}"),
      fn("for (let i = 0; i <= x.length; i++) {}"),
    ),
  )
  it("S6: a unary operator", changes(fn("send(!x)"), fn("send(-x)")))
  it("S6: an update operator", changes(fn("a++"), fn("a--")))
  it("S6: nullish against logical or", changes(fn('save(v ?? "x")'), fn('save(v || "x")')))
  it("S6: a condition without an early exit", changes(fn("if (a > 0) go()"), fn("if (a < 0) go()")))
  it("S6: an augmented assignment", changes(fn("a += b"), fn("a -= b")))
  it("S6: `let` against `const`", changes(fn("let i = 0; use(i)"), fn("const i = 0; use(i)")))
  it(
    "S6: `for…in` against `for…of`",
    changes(fn("for (const k in x) use(k)"), fn("for (const k of x) use(k)")),
  )
  it(
    "S6: a primitive type in an assertion",
    changes(fn("save(x as string)"), fn("save(x as number)")),
  )
  it(
    "S6: a concise arrow's operator",
    changes(
      "export const add = (a: number, b: number) => a + b",
      "export const add = (a: number, b: number) => a - b",
    ),
  )
  it(
    "S6: an accessibility modifier",
    changes("export class C { private secret = 1 }", "export class C { public secret = 1 }"),
  )
  it(
    "S6: a field's primitive type",
    changes("export class C { count: number = 0 }", "export class C { count: string = 0 }"),
  )
  it(
    "S6: `static` and `readonly`",
    changes("export class C { y = 2 }", "export class C { static readonly y = 2 }"),
  )

  const same = (before: string, after: string) => async () => {
    expect(await normalizeFirstSymbol(before)).toBe(await normalizeFirstSymbol(after))
  }
  it("S7: single against double quotes", same(fn("save('x')"), fn('save("x")')))
  it("S7: a trailing comma", same(fn("save(a, b)"), fn("save(a, b,)")))
  it("S7: optional semicolons", same(fn("save(a); save(b);"), fn("save(a)\n save(b)")))
  it(
    "S7: interface member separators",
    same(
      "export interface I { a: string; b: number }",
      "export interface I { a: string, b: number }",
    ),
  )
})
