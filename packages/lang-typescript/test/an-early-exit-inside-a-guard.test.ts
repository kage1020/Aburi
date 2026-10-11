import { describe, expect, it } from "vitest"
import { walkFirstSymbol, walkOf } from "./fixtures/ctx"

describe("an `if` whose consequence leaves early is a guard", () => {
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
  ])("counts `%s`", async (_label, source) => {
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
    [
      "a labeled break inside a callback, which JavaScript refuses but the grammar parses",
      "export function f(rows: any) { outer: for (const r of rows) { if (r) { run(() => { break outer }) } } }",
      [],
      ["loop"],
    ],
    [
      "a return inside a class static block, which JavaScript refuses but the grammar parses",
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
