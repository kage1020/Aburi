import { describe, expect, it } from "vitest"
import { importsOf, symbolsOf, walkFirstSymbol, walkOf } from "./fixtures/ctx"

describe("nested calls inside call-only return", () => {
  it("records the inner call of `return foo(bar())`", async () => {
    const { calls } = await walkFirstSymbol("export function f() { return foo(bar()) }")
    const targets = calls.map((c) => c.target)
    expect(targets).toContain("foo")
    expect(targets).toContain("bar")
  })
})

describe("default + namespace binding preservation", () => {
  it("emits both a default-binding edge and a namespace edge", async () => {
    const { imports } = await importsOf("import Foo, * as Bar from './x'")
    expect(imports.find((e) => e.symbols === "*")).toBeDefined()
    expect(
      imports.find((e) => Array.isArray(e.symbols) && e.symbols.includes("default as Foo")),
    ).toBeDefined()
  })
})

describe("dynamic import specifier shapes", () => {
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
    const { imports, errors } = await importsOf(source)
    expect(imports.every((e) => !e.dynamic)).toBe(true)
    expect(errors).toEqual([])
  })
})

describe("containsEarlyExit coverage", () => {
  it.each([
    [
      "continue",
      "export function f(items: number[]) { for (const x of items) { if (x < 0) continue } }",
    ],
    ["break", "export function f(items: number[]) { for (const x of items) { if (x < 0) break } }"],
    ["process.exit()", "export function f(x: unknown) { if (x) process.exit(1) }"],
    [
      "a labeled break of an outer loop",
      "export function f(rows: number[][]) { outer: for (const r of rows) { for (const x of r) { if (x < 0) { for (;;) break outer } } } }",
    ],
    [
      "a continue past a nested switch",
      "export function f(items: number[]) { for (const x of items) { if (x) { switch (x) { case 1: continue } } } }",
    ],
    [
      "a return beside a callback",
      "export function f(xs: number[]) { if (xs) { xs.forEach((x) => x); return } }",
    ],
    [
      "a break of the switch around the if",
      'export function f(k: string, ok: boolean) { switch (k) { case "a": if (!ok) break; run() } }',
    ],
    [
      "a throw inside a callback",
      "export function f(x: any) { if (!x) { run(() => { throw new Error() }) } }",
    ],
    [
      "process.exit() inside a callback",
      "export function f(x: any) { if (!x) { run(() => { process.exit(1) }) } }",
    ],
    [
      "process.exit() returned from a callback",
      "export function f(x: any) { if (!x) { run(() => { return process.exit(1) }) } }",
    ],
  ])("recognizes `%s` as an early exit inside a guard", async (_label, source) => {
    const { rules } = await walkFirstSymbol(source)
    expect(rules.filter((r) => r.type === "guard")).toHaveLength(1)
  })

  it.each([
    [
      "a return inside a callback",
      "export function f(x: any) { if (x.list) { x.list.forEach((i: any) => { if (!i) return; use(i) }) } }",
      ["!i"],
      ["guard"],
    ],
    [
      "a return inside a function expression",
      "export function f(x: any) { if (x) { run(function () { return x.n + 1 }) } }",
      [],
      ["return"],
    ],
    [
      "a return inside a nested function declaration",
      "export function f(x: any) { if (x) { function inner() { return x.n + 1 } run(inner) } }",
      [],
      ["return"],
    ],
    [
      "a return inside a generator",
      "export function f(x: any) { if (x) { run(function* () { return x.n + 1 }) } }",
      [],
      ["return"],
    ],
    [
      "a return inside a nested generator declaration",
      "export function f(x: any) { if (x) { function* gen() { return x.n + 1 } run(gen) } }",
      [],
      ["return"],
    ],
    [
      "a return inside a class method",
      "export function f(x: any) { if (x) { register(class { m() { return x.n + 1 } }) } }",
      [],
      ["return"],
    ],
    // Syntax errors to JavaScript that the grammar parses cleanly, so the walk meets them too.
    [
      "a labeled break inside a callback",
      "export function f(rows: any) { outer: for (const r of rows) { if (r) { run(() => { break outer }) } } }",
      [],
      ["loop"],
    ],
    [
      "a return inside a class static block",
      "export function f(x: any) { if (x) { use(class { static { if (y()) return } }) } }",
      ["y()"],
      ["guard"],
    ],
    [
      "a break of a nested switch",
      "export function f(x: any, y: number) { if (x.mode) { switch (y) { case 1: a(); break } } }",
      [],
      ["switch"],
    ],
    [
      "a break of an inner loop",
      "export function f(x: any) { for (const k of x.rows) { if (k) { for (const j of k) { if (j) break } } } }",
      ["j"],
      ["loop", "loop", "guard"],
    ],
    [
      "a break of an inner C-style loop",
      "export function f(x: any) { if (x) { for (let i = 0; i < x.n; i++) { if (i > 3) break } } }",
      ["i > 3"],
      ["loop", "guard"],
    ],
    [
      "a continue of an inner loop",
      "export function f(x: any) { if (x) { while (next()) { continue } } }",
      [],
      ["loop"],
    ],
    [
      "a continue of an inner do loop",
      "export function f(x: any) { if (x) { do { if (next()) continue } while (more()) } }",
      ["next()"],
      ["loop", "guard"],
    ],
    [
      "a labeled break of a label inside the consequence",
      "export function f(x: any) { if (x) { inner: { if (y()) break inner } } }",
      ["y()"],
      ["guard"],
    ],
  ])("does not count %s", async (_label, source, guards, types) => {
    // By id, so a nested declaration that became a Symbol of its own could not stand in for `f`.
    const { rules } = await walkOf(source, "ts:src/a.ts#f")
    expect(rules.filter((r) => r.type === "guard").map((r) => r.condition)).toEqual(guards)
    expect(rules.map((r) => r.type)).toEqual(types)
  })

  it.each([
    ["a trivial", "i.id"],
    ["a call-only", "toDto(i)"],
  ])("keeps the rules when %s arrow body becomes a block body", async (_label, body) => {
    const concise = await walkFirstSymbol(
      `export function h(x: any) { if (x.items) { save(x.items.map((i: any) => ${body})) } }`,
    )
    const block = await walkFirstSymbol(
      `export function h(x: any) { if (x.items) { save(x.items.map((i: any) => { return ${body} })) } }`,
    )
    expect(block.rules).toEqual(concise.rules)
  })
})

describe("try/catch/finally walk contract", () => {
  it.each([
    ["catch (e) { … }", "catch (e) { if (!e) return; errorHandler(e); throw e }"],
    ["catch { … }", "catch { if (!ok) return; errorHandler(); throw failure }"],
  ])("records the calls of `%s` and keeps its rules out", async (_label, clause) => {
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

  it("records the calls a catch clause would record as a try block, and withholds its rule", async () => {
    const { calls, rules } = await walkFirstSymbol(
      "export function f(a: number[]) { try { return a[g()] } catch (e) { return a[h()] } }",
    )
    expect(rules.map((r) => [r.type, r.expr])).toEqual([
      ["try", null],
      ["return", "a[g()]"],
    ])
    expect(calls.map((c) => c.target)).toEqual(["g", "h"])
  })

  it("withholds the rules of a finally block nested inside a catch clause", async () => {
    const { calls, rules } = await walkFirstSymbol(
      "export function f() { try { a() } catch (e) { try { b() } finally { if (y) return; c() } } }",
    )
    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls.map((c) => c.target)).toEqual(["a", "b", "c"])
  })
})

describe("import dedupe is order-insensitive on symbols", () => {
  it("collapses `import { A, B }` and `import { B, A }` to the same edge", async () => {
    const [a] = (await importsOf("import { A, B } from './x'")).imports
    const [b] = (await importsOf("import { B, A } from './x'")).imports
    if (a === undefined || b === undefined) throw new Error("edges missing")
    // The dedupe key is order-insensitive; the returned edges preserve source order.
    expect(new Set(a.symbols)).toEqual(new Set(b.symbols))
  })
})

describe("throw factory / identifier feeds throws[]", () => {
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
