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

describe("I3: try/catch/finally walk contract", () => {
  it.each([
    ["catch (e) { … }", "catch (e) { if (!e) return; errorHandler(e); throw e }"],
    ["catch { … }", "catch { if (!ok) return; errorHandler(); throw failure }"],
  ])("records the calls of `%s` and keeps its rules out", async (_label, clause) => {
    // ir-schema.md §8.2 withholds a catch clause's rules, so a rewritten error handler's
    // control flow does not move the logic axis. Its calls are another matter: no other Symbol
    // records them, and a database write added there reached no effect at all. Both spellings
    // of the clause, with a binding and without one, hand the walk the same `catch_clause`.
    const { calls, rules } = await walkFirstSymbol(
      `export function f() { try { doThing() } ${clause} }`,
    )
    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls.map((c) => c.target)).toEqual(["doThing", "errorHandler"])
  })

  it("walks the finally block like the try block", async () => {
    // The finally block runs on every path, so its rules and calls are the Symbol's.
    const { calls, rules } = await walkFirstSymbol(
      "export function f() { try { doThing() } finally { if (!held) return; release() } }",
    )
    expect(rules.map((r) => r.type)).toEqual(["try", "guard"])
    expect(calls.map((c) => c.target)).toEqual(["doThing", "release"])
  })

  it("takes the try block whole, the catch clause's calls and the finally block whole together", async () => {
    // The one guard is the finally block's; the catch clause's guard is withheld.
    const { calls, rules } = await walkFirstSymbol(
      "export function f() { try { a() } catch (e) { if (!e) return; b() } finally { if (x) return; c() } }",
    )
    expect(rules.map((r) => r.type)).toEqual(["try", "guard"])
    expect(calls.map((c) => c.target)).toEqual(["a", "b", "c"])
  })

  it("records the calls a catch clause would record as a try block, and no others", async () => {
    // `return a[g()]` is a trivial return, which the drop list stops at without recording the
    // call inside it (drop-list.md §5.5, LP19a). The catch clause is walked the same way
    // (LP20m), so the same statement gives the same answer on both sides.
    const { calls, rules } = await walkFirstSymbol(
      "export function f(a: number[]) { try { return a[g()] } catch (e) { return a[h()] } }",
    )
    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls).toEqual([])
  })

  it("withholds the rules of a finally block nested inside a catch clause", async () => {
    // Running on every path of the inner try does not lift a finally out of the catch clause
    // it is written in: nothing under a catch clause gives the Symbol a rule.
    const { calls, rules } = await walkFirstSymbol(
      "export function f() { try { a() } catch (e) { try { b() } finally { if (y) return; c() } } }",
    )
    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls.map((c) => c.target)).toEqual(["a", "b", "c"])
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
