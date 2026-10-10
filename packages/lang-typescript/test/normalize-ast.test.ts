import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolsOf } from "./fixtures/ctx"

async function normalizeFirstSymbol(source: string): Promise<string> {
  const [target] = await symbolsOf(source)
  if (target === undefined) throw new Error("no symbols in fixture")
  return normalizeAst(target)
}

// The harness `fingerprint.md` §7.7.1 requires of every language plugin, case for case.
describe("normalizeAst — the language plugin contract (fingerprint.md §7.7.1)", () => {
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

  it("S2a: the quotes around a string leave the normalized form unchanged", async () => {
    const single = await normalizeFirstSymbol("export function f() { save('x') }")
    const double = await normalizeFirstSymbol('export function f() { save("x") }')
    expect(single).toBe(double)
  })

  it("S2b: a trailing comma leaves the normalized form unchanged", async () => {
    const without = await normalizeFirstSymbol("export function f() { save(a, b) }")
    const trailing = await normalizeFirstSymbol("export function f() { save(a, b,) }")
    expect(without).toBe(trailing)
  })

  it("S2c: optional semicolons leave the normalized form unchanged", async () => {
    const terminated = await normalizeFirstSymbol("export function f() { save(a); save(b); }")
    const bare = await normalizeFirstSymbol("export function f() {\n  save(a)\n  save(b)\n}")
    expect(terminated).toBe(bare)
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

  it("S5a: changing an operator changes the normalized form", async () => {
    const plus = await normalizeFirstSymbol("export function f() { save(a + b) }")
    const minus = await normalizeFirstSymbol("export function f() { save(a - b) }")
    expect(plus).not.toBe(minus)
  })
})

describe("normalizeAst — operators, keywords and modifiers", () => {
  const changes = (before: string, after: string) => async () => {
    const one = await normalizeFirstSymbol(before)
    const two = await normalizeFirstSymbol(after)
    expect(one).not.toBe(two)
  }
  const fn = (body: string) => `export function f(a: any, b: any, x: any, v: any) { ${body} }`

  it(
    "S5a: a binary operator",
    changes(fn("const t = a + b; save(t)"), fn("const t = a - b; save(t)")),
  )
  it("S5a: a logical operator", changes(fn("audit(a && b)"), fn("audit(a || b)")))
  it("S5a: a comparison", changes(fn("track(x === null)"), fn("track(x !== null)")))
  it(
    "S5a: a loop bound",
    changes(
      fn("for (let i = 0; i < x.length; i++) {}"),
      fn("for (let i = 0; i <= x.length; i++) {}"),
    ),
  )
  it("S5a: a unary operator", changes(fn("send(!x)"), fn("send(-x)")))
  it("S5a: an update operator", changes(fn("a++"), fn("a--")))
  it("S5a: nullish against logical or", changes(fn('save(v ?? "x")'), fn('save(v || "x")')))
  it(
    "S5a: a condition without an early exit",
    changes(fn("if (a > 0) go()"), fn("if (a < 0) go()")),
  )
  it("S5a: an augmented assignment", changes(fn("a += b"), fn("a -= b")))
  it("S5a: `let` against `const`", changes(fn("let i = 0; use(i)"), fn("const i = 0; use(i)")))
  it(
    "S5a: `for…in` against `for…of`",
    changes(fn("for (const k in x) use(k)"), fn("for (const k of x) use(k)")),
  )
  it(
    "S5a: a primitive type in an assertion",
    changes(fn("save(x as string)"), fn("save(x as number)")),
  )
  it(
    "S5a: a concise arrow's operator",
    changes(
      "export const add = (a: number, b: number) => a + b",
      "export const add = (a: number, b: number) => a - b",
    ),
  )
  it(
    "S5a: an accessibility modifier",
    changes("export class C { private secret = 1 }", "export class C { public secret = 1 }"),
  )
  it(
    "S5a: a field's primitive type",
    changes("export class C { count: number }", "export class C { count: string }"),
  )
  it("S5a: `static`", changes("export class C { y = 2 }", "export class C { static y = 2 }"))
  it("S5a: `readonly`", changes("export class C { y = 2 }", "export class C { readonly y = 2 }"))
  it(
    "S5a: `async` on a method",
    changes("export class C { async m() { go() } }", "export class C { m() { go() } }"),
  )
  it(
    "S5a: an optional property",
    changes("export interface I { a?: string }", "export interface I { a: string }"),
  )
  it(
    "S5a: a definite assignment",
    changes("export class C { x!: number }", "export class C { x: number }"),
  )
  it(
    "S5a: `declare` on a field",
    changes("export class C { declare y: number }", "export class C { y: number }"),
  )

  const same = (before: string, after: string) => async () => {
    expect(await normalizeFirstSymbol(before)).toBe(await normalizeFirstSymbol(after))
  }
  it("S2a: single against double quotes", same(fn("save('x')"), fn('save("x")')))
  it("S2b: a trailing comma", same(fn("save(a, b)"), fn("save(a, b,)")))
  it("S2b: a trailing comma in an array", same(fn("save([a, b])"), fn("save([a, b,])")))
  it("S2c: optional semicolons", same(fn("save(a); save(b);"), fn("save(a)\n save(b)")))
  it(
    "S2c: interface member separators",
    same(
      "export interface I { a: string; b: number }",
      "export interface I { a: string, b: number }",
    ),
  )
})

describe("normalizeAst — holes in an array", () => {
  const fn = (body: string) => `export function f(a: any, x: any) { ${body} }`
  const differ = async (before: string, after: string) =>
    expect(await normalizeFirstSymbol(fn(before))).not.toBe(await normalizeFirstSymbol(fn(after)))

  it("tells a leading hole in a destructuring pattern from none", async () => {
    await differ(
      "const [, token] = a.split(' '); use(token)",
      "const [token] = a.split(' '); use(token)",
    )
  })

  it("tells a hole between elements from none", async () => {
    await differ("save([1, , 3])", "save([1, 3])")
  })

  it("tells a hole before a trailing comma from the trailing comma alone", async () => {
    await differ("save([x, ,])", "save([x,])")
  })

  it("does not read a comment where a hole is as an element", async () => {
    expect(await normalizeFirstSymbol(fn("save([/* skip */, x])"))).toBe(
      await normalizeFirstSymbol(fn("save([, x])")),
    )
  })
})

describe("normalizeAst — what the parser inserted", () => {
  it("leaves out a MISSING node, so a broken body does not read like its repaired form", async () => {
    const form = await normalizeFirstSymbol("export function f(a: any) { save(a + ) }")

    expect(form).toContain('(binary_expression (identifier "a") "+")')
  })
})

describe("normalizeAst — the shape of the string", () => {
  it("keeps the tokens a formatter owns out, and every other token in", async () => {
    const source = `export function f(a: any, b: any) { save(a, [, b], { c: 1 }, 'd', \`e\${a}\`, (x: number) => x < 1); }`

    expect(await normalizeFirstSymbol(source)).toBe(
      [
        '(statement_block (expression_statement (call_expression (identifier "save") (arguments',
        ' (identifier "a")',
        ' (array "," (identifier "b"))',
        ' (object (pair (property_identifier "c") ":" (number "1")))',
        ' (string (string_fragment "d"))',
        ' (template_string (string_fragment "e") (template_substitution "${" (identifier "a")))',
        ' (arrow_function (formal_parameters (required_parameter (identifier "x")',
        ' (type_annotation ":" (predefined_type "number"))))',
        ' "=>" (binary_expression (identifier "x") "<" (number "1")))))))',
      ].join(""),
    )
  })
})
