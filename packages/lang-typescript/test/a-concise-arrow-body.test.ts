import { describe, expect, it } from "vitest"
import { parseErrorsOf, walkFirstSymbol, walkOf } from "./fixtures/ctx"

const rulesOf = async (source: string, path?: string) => (await walkFirstSymbol(source, path)).rules

describe("a concise arrow body is read as the block spelling's `return`", () => {
  it.each([
    [
      "a comparison",
      'export const f = (u: any) => u.role === "admin"',
      'export function f(u: any) { return u.role === "admin" }',
    ],
    [
      "a ternary, in the parentheses a formatter adds",
      "export const f = (a: any, b: any) => (a > b ? a : b)",
      "export function f(a: any, b: any) { return a > b ? a : b }",
    ],
    [
      "an object literal, in the parentheses the grammar requires",
      'export const f = (a: any) => ({ ...a, status: "ok" })',
      'export function f(a: any) { return { ...a, status: "ok" } }',
    ],
    [
      "a call combined with something else",
      "export const f = (a: any) => g(a) + 1",
      "export function f(a: any) { return g(a) + 1 }",
    ],
    [
      "an awaited call in an async arrow",
      "export const f = async (a: any) => await g(a)",
      "export async function f(a: any) { return await g(a) }",
    ],
    [
      "an interpolated template literal",
      `export const f = (name: string) => \`hello \${name}\``,
      `export function f(name: string) { return \`hello \${name}\` }`,
    ],
    [
      "a non-null assertion on a member chain",
      "export const f = (u: any) => u.role!",
      "export function f(u: any) { return u.role! }",
    ],
    [
      "a curried arrow, whose returned value is the whole inner arrow",
      "export const add = (a: number) => (b: number) => a + b",
      "export function add(a: number) { return (b: number) => a + b }",
    ],
  ])("reads %s", async (_label, concise, block) => {
    const rules = await rulesOf(concise)

    expect(rules).toHaveLength(1)
    expect(rules).toEqual(await rulesOf(block))
  })

  it("reads a JSX body the same way, markup and all", async () => {
    const rules = await rulesOf(
      'export const C = ({ label }: any) => <div className="a">{label}</div>',
      "src/a.tsx",
    )

    expect(rules.map((r) => r.expr)).toEqual(['<div className="a">{label}</div>'])
    expect(rules).toEqual(
      await rulesOf(
        'export function C({ label }: any) { return <div className="a">{label}</div> }',
        "src/a.tsx",
      ),
    )
  })

  it("leaves out the parentheses a formatter wraps JSX in, and keeps their line", async () => {
    const source = [
      "export const C = ({ label }: any) => (",
      '  <div className="a">',
      "    {label}",
      "  </div>",
      ")",
    ].join("\n")

    expect((await rulesOf(source, "src/a.tsx")).map((r) => [r.line, r.expr])).toEqual([
      [1, '<div className="a"> {label} </div>'],
    ])
  })

  it.each([
    ["one call", "(id: string) => fetchUser(id)", ["fetchUser"]],
    ["one `new`", "(id: string) => new User(id)", ["User"]],
    ["a parenthesized call", "() => (g())", ["g"]],
    ["a member chain", "(u: any) => u.role", []],
    ["a literal", '() => "admin"', []],
    ["a negated name", "(x: boolean) => !x", []],
  ])("adds no rule for %s, as `return` would not", async (_label, arrow, targets) => {
    const { rules, calls } = await walkFirstSymbol(`export const f = ${arrow}`)

    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(targets)
  })

  it.each([
    [
      "a callback inside the body",
      "export function f(xs: number[]) { return xs.map((x) => x * 2) }",
      ["xs.map"],
    ],
    [
      "a parameter default",
      "export function f(cb = (x: number) => x + 1) { return cb(1) }",
      ["cb"],
    ],
  ])("adds no rule for an arrow that is not a walk root: %s", async (_label, source, targets) => {
    const { rules, calls } = await walkFirstSymbol(source)

    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(targets)
  })

  it.each([
    ["a computed subscript", "export const f = (a: any) => a[g()]", "a[g()]", ["g"]],
    [
      "a comparison of two calls",
      "export const f = (a: number) => g(a) > h(a)",
      "g(a) > h(a)",
      ["g", "h"],
    ],
  ])("still records the calls inside %s", async (_label, source, expr, targets) => {
    const { rules, calls } = await walkFirstSymbol(source)

    expect(rules.map((r) => [r.type, r.expr])).toEqual([["return", expr]])
    expect(calls.map((c) => c.target)).toEqual(targets)
  })

  it("puts the rule on the body's first line, which is the opening parenthesis's", async () => {
    const bare = ["export const f = (a: number, b: number) =>", "  a + b"].join("\n")
    const wrapped = ["export const f = (a: number, b: number) => (", "  a + b", ")"].join("\n")
    const block = ["export function f(a: number, b: number) { return (", "  a + b", ") }"].join(
      "\n",
    )

    expect((await rulesOf(bare)).map((r) => [r.line, r.expr])).toEqual([[2, "a + b"]])
    expect((await rulesOf(wrapped)).map((r) => [r.line, r.expr])).toEqual([[1, "a + b"]])
    expect((await rulesOf(block)).map((r) => r.line)).toEqual([1])
  })
})

describe("parentheses around a returned value", () => {
  it.each([
    ["one pair", "(a > b ? a : b)", "a > b ? a : b"],
    ["every pair", "((a + 1))", "a + 1"],
    ["a pair holding a comment", "(/* keep */ { a: 1 })", "{ a: 1 }"],
    [
      "a formatter's pair around multi-line JSX",
      '(\n    <div className="a">{b}</div>\n  )',
      '<div className="a">{b}</div>',
    ],
  ])("%s comes off, in a concise body and a block alike", async (_label, value, expr) => {
    const concise = await rulesOf(`export const f = (a: any, b: any) => ${value}`, "src/a.tsx")
    const block = await rulesOf(
      `export function f(a: any, b: any) { return ${value} }`,
      "src/a.tsx",
    )

    expect(concise.map((r) => r.expr)).toEqual([expr])
    expect(block.map((r) => r.expr)).toEqual([expr])
  })

  it.each([
    ["export function f() { return (g()) }"],
    ["export function f() { return ((g())) }"],
    ["export function f() { return (/* c */ g()) }"],
  ])("leave a call call-only: %s", async (source) => {
    const { rules, calls } = await walkFirstSymbol(source)

    expect(rules).toEqual([])
    expect(calls.map((c) => c.target)).toEqual(["g"])
  })

  it.each([
    ["export function f(x: any) { return (/* c */ x) }"],
    ["export function f(x: any) { return !(/* c */ x) }"],
    ["export function f(x: any) { return (/* c */ x).y }"],
    ["export const f = (x: any) => !(/* c */ x)"],
  ])("leave a trivial value trivial: %s", async (source) => {
    expect(await rulesOf(source)).toEqual([])
  })

  it.each([
    ["export function f(x: any) { return (x; }", ["(x"]],
    ["export function f(a: any) { return (a +) }", ["(a +)"]],
    ["export function f(a: any, b: any) { return (a b) }", ["(a b)"]],
    ["export const f = (x: any) => (x;", ["(x"]],
  ])("stay on a value the grammar repaired: %s", async (source, exprs) => {
    expect((await parseErrorsOf(source)).length).toBeGreaterThan(0)
    expect((await rulesOf(source)).map((r) => r.expr)).toEqual(exprs)
  })

  it("stay on a pair that holds more than one expression", async () => {
    const source = "export function f(x: any) { return (x: number) }"

    expect(await parseErrorsOf(source)).toEqual([])
    expect((await rulesOf(source)).map((r) => r.expr)).toEqual(["(x: number)"])
  })
})

describe("a comment written straight after `return`", () => {
  it.each([
    ["export function f() { return /* c */ g() }", [], ["g"]],
    ["export function f() { return /* c */ 1 }", [], []],
    ["export function f() { return /* keep */ { a: 1 } }", ["{ a: 1 }"], []],
    ["export function f(a: number, b: number) { return /* c */ a + b }", ["a + b"], []],
  ])("is skipped, and the value read: %s", async (source, exprs, targets) => {
    const { rules, calls } = await walkFirstSymbol(source)

    expect(rules.map((r) => r.expr)).toEqual(exprs)
    expect(calls.map((c) => c.target)).toEqual(targets)
  })
})

describe("every walk root reads its concise arrow this way", () => {
  it.each([
    [
      "a class field",
      'export class C {\n  isAdmin = (u: any) => u.role === "admin"\n}',
      "ts:src/a.ts#C.isAdmin",
      'u.role === "admin"',
    ],
    [
      "an object literal's property",
      'export const can = { admin: (u: any) => u.role === "admin" }',
      "ts:src/a.ts#can.admin",
      'u.role === "admin"',
    ],
    [
      "a registered handler",
      'app.get("/x", (req: any, res: any) => req.user ?? res.anon)',
      "ts:src/a.ts#app__get__$x__d0",
      "req.user ?? res.anon",
    ],
    [
      "a default-exported arrow",
      "export default (x: number) => x + 1",
      "ts:src/a.ts#<default>",
      "x + 1",
    ],
    [
      "a function a const hands to a call",
      "export const d = xs.map((x: number) => x * 2)",
      "ts:src/a.ts#d",
      "x * 2",
    ],
  ])("%s", async (_label, source, id, expr) => {
    expect((await walkOf(source, id)).rules.map((r) => [r.type, r.expr])).toEqual([
      ["return", expr],
    ])
  })

  it("leaves the class holding such a field without the rule", async () => {
    const source = 'export class C {\n  isAdmin = (u: any) => u.role === "admin"\n}'

    expect((await walkOf(source, "ts:src/a.ts#C")).rules).toEqual([])
  })
})
