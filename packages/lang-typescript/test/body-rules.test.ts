import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

/** Each rule as its type and the one text it carries. */
function described(rules: Rule[]): [string, string | null][] {
  return rules.map((r) => [r.type, r.condition ?? r.what ?? r.expr ?? r.loopKind])
}

async function walked(body: string) {
  return walkFirstSymbol(`export function f(x: any, a: any, b: any) { ${body} }`)
}

describe("the rules a body yields", () => {
  it.each([
    [
      "a guard that throws",
      "if (x) throw new E()",
      [
        ["guard", "x"],
        ["throw", "E"],
      ],
    ],
    ["a literal return", "return 1", []],
    ["a return of a member chain off `this`", "return this.a.b.c", []],
    ["a return of a call", "return foo()", []],
    ["a computed return", "return a + b", [["return", "a + b"]]],
    ["a `for` loop", "for (let i = 0; i < 3; i++) {}", [["loop", "for"]]],
    ["a `for…of` loop", "for (const i of x) {}", [["loop", "for"]]],
    ["a `for…in` loop", "for (const k in x) {}", [["loop", "for"]]],
    ["a `while` loop", "while (true) {}", [["loop", "while"]]],
    ["a `do` loop", "do {} while (x)", [["loop", "do"]]],
    ["a `switch`", "switch (x) { case 1: go() }", [["switch", "x"]]],
    ["a `try`", "try { doThing() } catch {}", [["try", null]]],
  ])("reads %s", async (_label, body, expected) => {
    expect(described((await walked(body)).rules)).toEqual(expected)
  })

  it("records the call a call-only return makes, though it yields no rule", async () => {
    expect((await walked("return foo()")).calls.map((c) => c.target)).toEqual(["foo"])
  })

  it("keeps a loop's rule the same whatever bound it tests", async () => {
    const strict = await walked("for (let i = 0; i < x.length; i++) {}")
    const loose = await walked("for (let i = 0; i <= x.length; i++) {}")

    expect(loose.rules).toEqual(strict.rules)
  })
})

describe("a try statement", () => {
  it.each([
    ["catch (e) { … }", "catch (e) { if (!e) return; errorHandler(e); throw e }"],
    ["catch { … }", "catch { if (!ok) return; errorHandler(); throw failure }"],
  ])("records the calls of `%s` and keeps its rules out", async (_label, clause) => {
    const { calls, rules } = await walked(`try { doThing() } ${clause}`)

    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls.map((c) => c.target)).toEqual(["doThing", "errorHandler"])
  })

  it("walks the finally block like the try block, since it runs on every path", async () => {
    const { calls, rules } = await walked(
      "try { doThing() } finally { if (!held) return; release() }",
    )

    expect(rules.map((r) => r.type)).toEqual(["try", "guard"])
    expect(calls.map((c) => c.target)).toEqual(["doThing", "release"])
  })

  it("takes the try block and the finally block whole, and only the catch clause's calls", async () => {
    const { calls, rules } = await walked(
      "try { a() } catch (e) { if (!e) return; b() } finally { if (x) return; c() }",
    )

    expect(described(rules)).toEqual([
      ["try", null],
      ["guard", "x"],
    ])
    expect(calls.map((c) => c.target)).toEqual(["a", "b", "c"])
  })

  it("records the calls a catch clause would record as a try block, and withholds its rule", async () => {
    const { calls, rules } = await walked("try { return a[g()] } catch (e) { return a[h()] }")

    expect(described(rules)).toEqual([
      ["try", null],
      ["return", "a[g()]"],
    ])
    expect(calls.map((c) => c.target)).toEqual(["g", "h"])
  })

  it("withholds the rules of a finally block nested inside a catch clause", async () => {
    const { calls, rules } = await walked(
      "try { a() } catch (e) { try { b() } finally { if (y) return; c() } }",
    )

    expect(rules.map((r) => r.type)).toEqual(["try"])
    expect(calls.map((c) => c.target)).toEqual(["a", "b", "c"])
  })
})
