import { describe, expect, it } from "vitest"
import { importsOf, symbolsOf, walkFirstSymbol } from "./fixtures/ctx"

describe("C2: nested calls inside call-only return", () => {
  it("records the inner call of `return foo(bar())`", async () => {
    const { calls } = await walkFirstSymbol("export function f() { return foo(bar()) }")
    const targets = calls.map((c) => c.target)
    expect(targets).toContain("foo")
    expect(targets).toContain("bar")
  })
})

describe("C7: default + namespace binding preservation", () => {
  it("emits both a default-binding edge and a namespace edge", async () => {
    const { imports } = await importsOf("import Foo, * as Bar from './x'")
    expect(imports.find((e) => e.symbols === "*")).toBeDefined()
    expect(imports.find((e) => Array.isArray(e.symbols) && e.symbols.includes("Foo"))).toBeDefined()
  })
})

describe("C8: dynamic import specifier shapes", () => {
  it("emits a dynamic edge for a string-literal argument", async () => {
    const { imports } = await importsOf("export async function f() { await import('./x') }")
    const edge = imports.find((e) => e.dynamic)
    expect(edge).toBeDefined()
    expect(edge?.source).toBe("./x")
  })

  it.each([
    ["a variable", "export async function f(p: string) { await import(p) }"],
    ["a concatenation", 'export async function f(x: string) { await import("" + x) }'],
    [
      "a template literal with a substitution",
      `export async function f(p: string) { await import(\`./\${p}\`) }`,
    ],
  ])("silently ignores a non-literal specifier — %s", async (_label, source) => {
    // A computed specifier yields no edge because static dependency analysis has nothing to
    // record. The substitution is what makes the template computed; a template without one
    // names a fixed module and is read like any other literal (`import-forms.test.ts`).
    const { imports, errors } = await importsOf(source)
    expect(imports.every((e) => !e.dynamic)).toBe(true)
    // *Silently* is the load-bearing half, and it is what separates "this reader does not
    // follow computed specifiers" from "this specifier is empty". Collapsing those two
    // answers into one `null` is a one-line edit that no other assertion notices, and it
    // would report a fault against perfectly good code.
    expect(errors).toEqual([])
  })
})

describe("I2: containsEarlyExit coverage", () => {
  it.each([
    [
      "continue",
      "export function f(items: number[]) { for (const x of items) { if (x < 0) continue } }",
    ],
    ["break", "export function f(items: number[]) { for (const x of items) { if (x < 0) break } }"],
    ["process.exit()", "export function f(x: unknown) { if (x) process.exit(1) }"],
  ])("recognizes `%s` as an early exit inside a guard", async (_label, source) => {
    const { rules } = await walkFirstSymbol(source)
    expect(rules.filter((r) => r.type === "guard")).toHaveLength(1)
  })
})

describe("I3: try/catch/finally scope pin", () => {
  it("keeps catch body calls out of the try rule's Symbol calls", async () => {
    const { calls, rules } = await walkFirstSymbol(
      "export function f() { try { doThing() } catch { errorHandler() } }",
    )
    expect(rules.some((r) => r.type === "try")).toBe(true)
    // The catch handler's contents are semantically part of another Symbol's scope
    // (or dropped when trivial). doThing (inside try) is recorded; errorHandler is not.
    expect(calls.map((c) => c.target)).toContain("doThing")
    expect(calls.map((c) => c.target)).not.toContain("errorHandler")
  })
})

describe("I10: import dedupe is order-insensitive on symbols", () => {
  it("collapses `import { A, B }` and `import { B, A }` to the same edge", async () => {
    const [a] = (await importsOf("import { A, B } from './x'")).imports
    const [b] = (await importsOf("import { B, A } from './x'")).imports
    if (a === undefined || b === undefined) throw new Error("edges missing")
    // The dedupe key is order-insensitive; the returned edges preserve source order.
    expect(new Set(a.symbols)).toEqual(new Set(b.symbols))
  })
})

describe("I12: throw factory / identifier feeds throws[]", () => {
  it.each([
    ["`throw err` records the identifier", "export function f(err: Error) { throw err }", "err"],
    [
      "`throw makeError()` records the factory callee identifier",
      "export function f() { throw makeError() }",
      "makeError",
    ],
  ])("%s", async (_label, source, thrown) => {
    const [sym] = await symbolsOf(source)
    if (sym === undefined) throw new Error("symbol missing")
    expect(sym.signature?.throws).toContain(thrown)
  })
})
