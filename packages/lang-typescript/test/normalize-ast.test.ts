import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolsOf } from "./fixtures/ctx"

async function normalizeFirstSymbol(source: string): Promise<string> {
  const [target] = await symbolsOf(source)
  if (target === undefined) throw new Error("no symbols in fixture")
  return normalizeAst(target)
}

const fn = (body: string) => `export function f(a: any, b: any, x: any, v: any) { ${body} }`

describe("normalizeAst — what a formatter or a reviewer's eye would not call a change", () => {
  it.each([
    ["a comment in the body", fn("return 1"), fn("/* note */ return 1")],
    [
      "whitespace and indentation",
      "export function f(){return 1}",
      "export function f() {\n  return 1\n}",
    ],
    ["single against double quotes", fn("save('x')"), fn('save("x")')],
    ["a trailing comma in a call", fn("save(a, b)"), fn("save(a, b,)")],
    ["a trailing comma in an array", fn("save([a, b])"), fn("save([a, b,])")],
    ["optional semicolons", fn("save(a); save(b);"), fn("save(a)\n save(b)")],
    ["a comment where an array hole is", fn("save([/* skip */, x])"), fn("save([, x])")],
    [
      "interface member separators",
      "export interface I { a: string; b: number }",
      "export interface I { a: string, b: number }",
    ],
  ])("leaves the string as it was for %s", async (_label, before, after) => {
    expect(await normalizeFirstSymbol(after)).toBe(await normalizeFirstSymbol(before))
  })
})

describe("normalizeAst — what changes the string", () => {
  it.each([
    ["a statement added", fn("return 1"), fn("const y = 0; return 1")],
    [
      "an identifier renamed",
      "export function f(x: number) { return x }",
      "export function f(y: number) { return y }",
    ],
    ["a literal's value", fn("return 1"), fn("return 2")],
    ["a binary operator", fn("const t = a + b; save(t)"), fn("const t = a - b; save(t)")],
    ["a logical operator", fn("audit(a && b)"), fn("audit(a || b)")],
    ["a comparison", fn("track(x === null)"), fn("track(x !== null)")],
    [
      "a loop bound",
      fn("for (let i = 0; i < x.length; i++) {}"),
      fn("for (let i = 0; i <= x.length; i++) {}"),
    ],
    ["a unary operator", fn("send(!x)"), fn("send(-x)")],
    ["an update operator", fn("a++"), fn("a--")],
    ["nullish against logical or", fn('save(v ?? "x")'), fn('save(v || "x")')],
    ["a condition without an early exit", fn("if (a > 0) go()"), fn("if (a < 0) go()")],
    ["an augmented assignment", fn("a += b"), fn("a -= b")],
    ["`let` against `const`", fn("let i = 0; use(i)"), fn("const i = 0; use(i)")],
    ["`for…in` against `for…of`", fn("for (const k in x) use(k)"), fn("for (const k of x) use(k)")],
    ["a primitive type in an assertion", fn("save(x as string)"), fn("save(x as number)")],
    [
      "a concise arrow's operator",
      "export const add = (a: number, b: number) => a + b",
      "export const add = (a: number, b: number) => a - b",
    ],
    [
      "an accessibility modifier",
      "export class C { private secret = 1 }",
      "export class C { public secret = 1 }",
    ],
    [
      "a field's primitive type",
      "export class C { count: number }",
      "export class C { count: string }",
    ],
    ["`static`", "export class C { y = 2 }", "export class C { static y = 2 }"],
    ["`readonly`", "export class C { y = 2 }", "export class C { readonly y = 2 }"],
    [
      "`async` on a method",
      "export class C { async m() { go() } }",
      "export class C { m() { go() } }",
    ],
    [
      "an optional property",
      "export interface I { a?: string }",
      "export interface I { a: string }",
    ],
    ["a definite assignment", "export class C { x!: number }", "export class C { x: number }"],
    [
      "`declare` on a field",
      "export class C { declare y: number }",
      "export class C { y: number }",
    ],
    [
      "a leading hole in a destructuring pattern",
      fn("const [, token] = a.split(' '); use(token)"),
      fn("const [token] = a.split(' '); use(token)"),
    ],
    ["a hole between elements", fn("save([1, , 3])"), fn("save([1, 3])")],
    ["a hole before a trailing comma", fn("save([x, ,])"), fn("save([x,])")],
  ])("tells %s", async (_label, before, after) => {
    expect(await normalizeFirstSymbol(after)).not.toBe(await normalizeFirstSymbol(before))
  })
})

describe("normalizeAst — the shape of the string", () => {
  it("leaves out a node the parser inserted, so a broken body does not read like its repair", async () => {
    expect(await normalizeFirstSymbol(fn("save(a + )"))).toContain(
      '(binary_expression (identifier "a") "+")',
    )
  })

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
