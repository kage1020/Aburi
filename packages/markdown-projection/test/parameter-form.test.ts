import { describe, expect, it } from "vitest"
import { formatInput } from "../src/format"

/**
 * A plugin puts a parameter's `?` or `...` at the head of `type`, where the api fingerprint
 * reads it (lang-plugin.md LP11b). Printed as `name: type` it would read `ids: ...string[]`.
 */
describe("formatInput", () => {
  it.each([
    ["a", "string", "a: string"],
    ["a", "?string", "a?: string"],
    ["limit", "?", "limit?"],
    ["ids", "...string[]", "...ids: string[]"],
    ["args", "...", "...args"],
    ["x", "", "x: "],
  ])("prints %s with type %j as %j", (name, type, expected) => {
    expect(formatInput(name, type)).toBe(expected)
  })
})
