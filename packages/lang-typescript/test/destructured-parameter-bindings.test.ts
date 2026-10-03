import { describe, expect, it } from "vitest"
import { symbolOf, symbolsOf } from "./fixtures/ctx"

/**
 * A destructuring parameter's `name` is the pattern's text, which no call can name. The
 * identifiers the pattern binds go beside it in `bindings`, read the way a destructuring
 * declaration is (ir-schema.md §3.2): a rename binds its value, a default binds its left
 * side, and a rest element binds what it holds (lang-plugin.md LP11d).
 */

async function inputsOf(source: string, id = "ts:src/a.ts#f") {
  return (await symbolOf(source, id)).signature?.inputs
}

describe("a destructuring parameter lists the names it binds", () => {
  it.each([
    ["object shorthand", "function f({ save }: D) {}", ["save"]],
    ["array element", "function f([save]: D) {}", ["save"]],
    ["rename", "function f({ persist: save }: D) {}", ["save"]],
    ["shorthand default", "function f({ save = fallback }: D) {}", ["save"]],
    ["renamed default", "function f({ persist: save = fallback }: D) {}", ["save"]],
    ["array default", "function f([save = fallback]: D) {}", ["save"]],
    ["nested", "function f({ deps: { save, log: [first] } }: D) {}", ["save", "first"]],
    ["rest element", "function f({ a, ...rest }: D) {}", ["a", "rest"]],
    ["rest of a pattern", "function f(...[save, load]: D) {}", ["save", "load"]],
    ["whole-parameter default", "function f({ save } = {}) {}", ["save"]],
    ["optional parameter", "function f({ save }?: D) {}", ["save"]],
  ])("%s", async (_label, source, bindings) => {
    const [input] = (await inputsOf(source)) ?? []

    expect(input?.bindings).toEqual(bindings)
  })

  it("leaves the key out for a parameter that is a single name", async () => {
    const inputs = await inputsOf("function f(save: D, n = 1, this: X, ...rest: D[]) {}")

    for (const input of inputs ?? []) expect(Object.keys(input)).not.toContain("bindings")
  })

  it("reads an arrow and a method the same way", async () => {
    const arrow = await inputsOf("export const f = async ({ save }: D) => { await save(1) }")
    const method = await inputsOf("class C { handle({ save }: any) {} }", "ts:src/a.ts#C.handle")

    expect(arrow?.[0]?.bindings).toEqual(["save"])
    expect(method?.[0]?.bindings).toEqual(["save"])
  })
})

/**
 * A rest parameter's `name` is its binding without the `...`, and `rest` says it collects the
 * remaining arguments (LP11b). When that binding is itself a pattern, `name` is the pattern's
 * text and `bindings` lists what it binds, so the three fields together still name every
 * identifier the call resolver must treat as local. A single-name rest parameter is named by
 * its binding and needs no list.
 */
describe("a rest parameter whose binding destructures", () => {
  it.each([
    ["function f(...[x]: T) {}", { name: "[x]", type: "T", rest: true, bindings: ["x"] }],
    [
      "function f(...{ a, b: [c] }: T) {}",
      { name: "{ a, b: [c] }", type: "T", rest: true, bindings: ["a", "c"] },
    ],
    ["function f(...save: T[]) {}", { name: "save", type: "T[]", rest: true }],
  ])("reads %j", async (source, expected) => {
    expect(await inputsOf(source)).toStrictEqual([expected])
  })

  it("reads a method's the same way", async () => {
    const inputs = await inputsOf("class C { m(...[x]: T) {} }", "ts:src/a.ts#C.m")

    expect(inputs).toStrictEqual([{ name: "[x]", type: "T", rest: true, bindings: ["x"] }])
  })
})

/**
 * A recovered parse can leave a zero-width MISSING identifier where a pattern's binding would
 * be (`{ a: }`), or wrap text it could not place in an ERROR node (`{ a b }`). Neither is a
 * name the source wrote into a binding position, so neither is listed: the empty string would
 * be a binding the schema refuses, and an ERROR's text was never placed as one (LP11c's rule,
 * one level down; LP11d). The parameter keeps its written text as `name`, and the file keeps
 * every Symbol, as it did when the parameter was read by its text alone.
 */
describe("a destructuring parameter the parser repaired", () => {
  it("lists no binding the source did not write", async () => {
    const inputs = await inputsOf("function f({ a: }: T, { b, c: }: U) {}")

    expect(inputs).toStrictEqual([
      { name: "{ a: }", type: "T" },
      { name: "{ b, c: }", type: "U", bindings: ["b"] },
    ])
  })

  it.each([
    ["{ a, ? }", { name: "{ a, ? }", type: "", bindings: ["a"] }],
    ["{ a = }", { name: "{ a = }", type: "", bindings: ["a"] }],
    ["{ a b }", { name: "{ a b }", type: "", bindings: ["a"] }],
    ["[...]", { name: "[...]", type: "" }],
    ["{ ... }", { name: "{ ... }", type: "" }],
    ["...[a b]", { name: "[a b]", type: "", rest: true, bindings: ["a"] }],
  ])("reads `%s` around the text the parser could not place", async (params, expected) => {
    const symbols = await symbolsOf(`function f(${params}) {}\nfunction g(c) {}`)

    expect(symbols.map((s) => s.id)).toEqual(["ts:src/a.ts#f", "ts:src/a.ts#g"])
    expect(symbols[0]?.signature?.inputs).toStrictEqual([expected])
  })

  it("leaves a destructuring declaration refusing the same text", async () => {
    // Only the parameter path skips an ERROR node. A declaration's bindings become Symbols,
    // and one it could not read is refused rather than passed over (pattern-bindings.ts).
    await expect(symbolsOf("export const { a, ? } = m")).rejects.toThrow(/Unmodelled node "ERROR"/)
  })
})
