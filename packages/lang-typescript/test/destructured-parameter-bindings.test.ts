import { describe, expect, it } from "vitest"
import { symbolOf, symbolsOf } from "./fixtures/ctx"

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

    expect(inputs).toStrictEqual([
      { name: "save", type: "D" },
      { name: "n", type: "", optional: true },
      { name: "this", type: "X" },
      { name: "rest", type: "D[]", rest: true },
    ])
  })

  it("leaves the key out for a pattern that binds no name", async () => {
    const inputs = await inputsOf("function f({}: Props, []: T) {}")

    expect(inputs).toStrictEqual([
      { name: "{}", type: "Props" },
      { name: "[]", type: "T" },
    ])
  })

  it("reads an arrow and a method the same way", async () => {
    const arrow = await inputsOf("export const f = async ({ save }: D) => { await save(1) }")
    const method = await inputsOf("class C { handle({ save }: any) {} }", "ts:src/a.ts#C.handle")

    expect(arrow?.[0]?.bindings).toEqual(["save"])
    expect(method?.[0]?.bindings).toEqual(["save"])
  })

  it.each(["src/a.tsx", "src/a.jsx", "src/a.js"])("reads %s the same way", async (path) => {
    const source = "export function Card({ children }) { return <div>{children}</div> }"
    const card = (await symbolsOf(source, path)).find((s) => s.id === `ts:${path}#Card`)

    expect(card?.signature?.inputs).toStrictEqual([
      { name: "{ children }", type: "", bindings: ["children"] },
    ])
  })
})

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

/** The grammars a parameter list is read with: `.ts` loads one, `.js` and `.tsx` the other. */
const GRAMMARS = ["src/a.ts", "src/a.js", "src/a.tsx"]

async function survivingInputsOf(params: string, path: string) {
  const symbols = await symbolsOf(`function f(${params}) {}\nfunction g(c) {}`, path)

  expect(symbols.map((s) => s.id)).toEqual([`ts:${path}#f`, `ts:${path}#g`])
  return symbols[0]?.signature?.inputs
}

describe("a destructuring parameter the parser repaired", () => {
  it("lists no binding the source did not write", async () => {
    const inputs = await inputsOf("function f({ a: }: T, { b, c: }: U) {}")

    expect(inputs).toStrictEqual([
      { name: "{ a: }", type: "T" },
      { name: "{ b, c: }", type: "U", bindings: ["b"] },
    ])
  })

  describe.each(GRAMMARS)("in %s", (path) => {
    it.each([
      ["{ a, ? }", { name: "{ a, ? }", type: "", bindings: ["a"] }],
      ["{ a, ?, b }", { name: "{ a, ?, b }", type: "", bindings: ["a", "b"] }],
      ["{ a = }", { name: "{ a = }", type: "", bindings: ["a"] }],
      ["{ a b }", { name: "{ a b }", type: "", bindings: ["a"] }],
      ["{ a b, c }", { name: "{ a b, c }", type: "", bindings: ["a", "c"] }],
      ["[...]", { name: "[...]", type: "" }],
      ["{ ... }", { name: "{ ... }", type: "" }],
      ["...[a b]", { name: "[a b]", type: "", rest: true, bindings: ["a"] }],
    ])("reads `%s` around the text the parser could not place", async (params, expected) => {
      expect(await survivingInputsOf(params, path)).toStrictEqual([expected])
    })

    it.each([
      ["[a, ?, b]", { name: "[a, ?, b]", type: "", bindings: ["a", "b"] }],
      ["[a, ?]", { name: "[a, ?]", type: "", bindings: ["a"] }],
      ["[a, b c]", { name: "[a, b c]", type: "", bindings: ["a", "b"] }],
      ["[a, b c, d]", { name: "[a, b c, d]", type: "", bindings: ["a", "b", "d"] }],
      ["{ q, k: [a, ?] }", { name: "{ q, k: [a, ?] }", type: "", bindings: ["q", "a"] }],
      ["...[a, ?, b]", { name: "[a, ?, b]", type: "", rest: true, bindings: ["a", "b"] }],
      ["[a, ?, b] = []", { name: "[a, ?, b]", type: "", optional: true, bindings: ["a", "b"] }],
      [
        "[a = c, ?, { x, y: w }, [p], ...r]",
        {
          name: "[a = c, ?, { x, y: w }, [p], ...r]",
          type: "",
          bindings: ["a", "x", "w", "p", "r"],
        },
      ],
    ])("reads `%s`, which the parser kept as an expression", async (params, expected) => {
      expect(await survivingInputsOf(params, path)).toStrictEqual([expected])
    })

    it.each([
      // A `!` the source wrote is not the parser's repair, and an array expression binds nothing.
      ["[a]!", { name: "[a]!", type: "" }],
      // Two parameters the parser read as one subscript expression: no pattern at all.
      ["[a, b c], [d, ?]", { name: "[a, b c], [d, ?]", type: "" }],
    ])("lists nothing for `%s`, which is no pattern", async (params, expected) => {
      expect(await survivingInputsOf(params, path)).toStrictEqual([expected])
    })
  })

  it("leaves a destructuring declaration refusing the same text", async () => {
    await expect(symbolsOf("export const { a, ? } = m")).rejects.toThrow(/Unmodelled node "ERROR"/)
    await expect(symbolsOf("export const { q, k: [a, ?] } = m")).rejects.toThrow(
      /Unmodelled node "non_null_expression"/,
    )
  })
})

describe("a destructuring parameter holding an expression the grammar placed", () => {
  describe.each(GRAMMARS)("in %s", (path) => {
    it.each([
      ["{ a: obj.b }", { name: "{ a: obj.b }", type: "" }],
      ["[obj.a]", { name: "[obj.a]", type: "" }],
      ["[a[0]]", { name: "[a[0]]", type: "" }],
      ["{ a: b!, c }", { name: "{ a: b!, c }", type: "", bindings: ["c"] }],
      ["{ a: undefined }", { name: "{ a: undefined }", type: "" }],
    ])("reads `%s` and keeps the file", async (params, expected) => {
      expect(await survivingInputsOf(params, path)).toStrictEqual([expected])
    })
  })

  it("leaves a destructuring declaration refusing the same expression", async () => {
    await expect(symbolsOf("export const { a: obj.b } = m")).rejects.toThrow(
      /Unmodelled node "member_expression"/,
    )
  })
})
