import { describe, expect, it } from "vitest"
import { callsOf, classOf, hintOf, symbolOf } from "./fixtures/ctx"

describe("a generator function is a function wherever one is read", () => {
  it.each([
    [
      "a binding",
      "export const g = function* () { yield fetchPage() }",
      "ts:src/a.ts#g",
      "function",
      false,
    ],
    [
      "an async binding",
      "export const g = async function* () { yield fetchPage() }",
      "ts:src/a.ts#g",
      "function",
      true,
    ],
    [
      "a binding behind a wrapper",
      "export const g = (function* () { yield fetchPage() }) as Pages",
      "ts:src/a.ts#g",
      "function",
      false,
    ],
    [
      "an anonymous default export",
      "export default function* () { yield fetchPage() }",
      "ts:src/a.ts#<default>",
      "function",
      false,
    ],
    [
      "an async anonymous default export",
      "export default async function* () { yield fetchPage() }",
      "ts:src/a.ts#<default>",
      "function",
      true,
    ],
    [
      "a class field",
      classOf("  pages = function* () { yield fetchPage() }"),
      "ts:src/a.ts#C.pages",
      "method",
      false,
    ],
    [
      "an object entry",
      "export const api = { pages: function* () { yield fetchPage() } }",
      "ts:src/a.ts#api.pages",
      "method",
      false,
    ],
  ])("gives %s a Symbol of its own whose body is the generator's", async (_site, source, id, kind, async) => {
    const symbol = await symbolOf(source, id)

    expect([symbol.kind, symbol.signature?.async, symbol.signature?.generator]).toEqual([
      kind,
      async,
      true,
    ])
    expect(await callsOf(source, id)).toEqual(["fetchPage"])
  })

  it("takes the generator off the class it is a field of", async () => {
    const source = classOf("  pages = function* () { yield fetchPage() }")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })

  it.each([
    [
      "a const hands to a call",
      "export const w = wrap(function* () { yield fetchPage() })",
      "ts:src/a.ts#w",
      "call-argument-function",
    ],
    [
      "a registration is handed",
      "app.use(function* (ctx: any, next: any) { yield fetchPage() })",
      "ts:src/a.ts#app__use__d0",
      "inline-handler",
    ],
  ])("walks a generator %s as its body", async (_site, source, id, evidence) => {
    const symbol = await symbolOf(source, id)

    expect(symbol.derivedBy).toContain(evidence)
    expect(await callsOf(source, id)).toEqual(["fetchPage"])
  })
})
