import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { formatInput, signatureLine } from "../src/format"

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
