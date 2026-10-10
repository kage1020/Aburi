import { sig } from "@aburi/test-support"
import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { signatureLine } from "../src"
import { formatInput } from "../src/format"

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
  it.each<[string, Partial<Signature>, string]>([
    [
      "optional and rest inputs in TypeScript's spelling",
      {
        inputs: [
          { name: "a", type: "string", optional: true },
          { name: "ids", type: "string[]", rest: true },
        ],
      },
      "`(a?: string, ...ids: string[]) → void`",
    ],
    ["no outputs as void", { outputs: [] }, "`() → void`"],
    ["several outputs as a union", { outputs: ["A", "B"] }, "`() → A | B`"],
    ["type parameters ahead of the inputs", { typeParameters: ["T", "U"] }, "`<T,U>() → void`"],
    [
      "what it throws after the code span",
      { throws: ["NotFound", "Denied"] },
      "`() → void` throws NotFound, Denied",
    ],
    [
      "async and generator as badges",
      { async: true, generator: true },
      "`() → void` ⚡async *generator*",
    ],
  ])("writes %s", (_, overrides, line) => {
    expect(signatureLine(sig(overrides))).toBe(line)
  })

  it.each([null, undefined])("writes nothing for a %s signature", (signature) => {
    expect(signatureLine(signature)).toBeNull()
  })
})
