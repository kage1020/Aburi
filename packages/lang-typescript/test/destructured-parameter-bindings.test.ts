import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

/**
 * A destructuring parameter's `name` is the pattern's text, which no call can name. The
 * identifiers the pattern binds go beside it in `bindings`, read the way a destructuring
 * declaration is (ir-schema.md §3.2): a rename binds its value, a default binds its left
 * side, and a rest element binds what it holds.
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
    ["rest parameter", "function f(...save: D[]) {}", ["save"]],
    ["rest of a pattern", "function f(...[save, load]: D) {}", ["save", "load"]],
    ["whole-parameter default", "function f({ save } = {}) {}", ["save"]],
    ["optional parameter", "function f({ save }?: D) {}", ["save"]],
  ])("%s", async (_label, source, bindings) => {
    const [input] = (await inputsOf(source)) ?? []

    expect(input?.bindings).toEqual(bindings)
  })

  it("leaves the key out for a parameter that is a single name", async () => {
    const inputs = await inputsOf("function f(save: D, n = 1, this: X) {}")

    for (const input of inputs ?? []) expect(Object.keys(input)).not.toContain("bindings")
  })

  it("reads an arrow and a method the same way", async () => {
    const arrow = await inputsOf("export const f = async ({ save }: D) => { await save(1) }")
    const method = await inputsOf("class C { handle({ save }: any) {} }", "ts:src/a.ts#C.handle")

    expect(arrow?.[0]?.bindings).toEqual(["save"])
    expect(method?.[0]?.bindings).toEqual(["save"])
  })
})
