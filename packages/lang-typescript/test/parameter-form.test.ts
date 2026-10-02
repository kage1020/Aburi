import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

/**
 * What a caller sees of a parameter's form rides in `type`, the field the api fingerprint
 * hashes: `?` for an optional or defaulted parameter, `...` for a rest one (LP11b, issue #340).
 */

async function inputsOf(params: string) {
  const symbol = await symbolOf(`export function f(${params}) {}`, "ts:src/a.ts#f")
  return symbol.signature?.inputs
}

describe("readParameters — the form of a parameter", () => {
  it.each([
    ["a required parameter", "a: string", [{ name: "a", type: "string" }]],
    ["an optional parameter", "a?: string", [{ name: "a", type: "?string" }]],
    ["a defaulted parameter", "limit: number = 10", [{ name: "limit", type: "?number" }]],
    ["an untyped defaulted parameter", "limit = 10", [{ name: "limit", type: "?" }]],
    ["a rest parameter", "...ids: string[]", [{ name: "ids", type: "...string[]" }]],
    ["a destructured rest parameter", "...[p, q]: T", [{ name: "[p, q]", type: "...T" }]],
    ["a defaulted destructured parameter", "{ x }: Opts = {}", [{ name: "{ x }", type: "?Opts" }]],
  ])("records %s", async (_label, params, expected) => {
    expect(await inputsOf(params)).toEqual(expected)
  })

  it("leaves the default's value out, so changing it changes no input", async () => {
    expect(await inputsOf("limit = 20")).toEqual(await inputsOf("limit = 10"))
  })
})
