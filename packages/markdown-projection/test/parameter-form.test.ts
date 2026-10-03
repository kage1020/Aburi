import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { formatInput, signatureLine } from "../src/format"

/**
 * A parameter's `optional` and `rest` fields (ir-schema.md §7) print where TypeScript writes
 * them. Printed as `name: type` alone, `a?: string` and `...ids: string[]` would both read as
 * a required parameter.
 */
describe("formatInput", () => {
  it.each([
    [{ name: "a", type: "string" }, "a: string"],
    [{ name: "a", type: "string", optional: true }, "a?: string"],
    [{ name: "limit", type: "", optional: true }, "limit?"],
    [{ name: "ids", type: "string[]", rest: true }, "...ids: string[]"],
    [{ name: "args", type: "", rest: true }, "...args"],
    [{ name: "x", type: "" }, "x"],
  ])("prints %j as %j", (input, expected) => {
    expect(formatInput(input)).toBe(expected)
  })
})

describe("signatureLine", () => {
  it("prints an optional and a rest input in TypeScript's spelling", () => {
    const signature: Signature = {
      inputs: [
        { name: "a", type: "string", optional: true },
        { name: "ids", type: "string[]", rest: true },
      ],
      outputs: ["void"],
      throws: [],
      async: false,
      generator: false,
      typeParameters: [],
    }
    expect(signatureLine(signature)).toBe("`(a?: string, ...ids: string[]) → void`")
  })
})
