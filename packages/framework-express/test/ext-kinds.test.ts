import { describe, expect, it } from "vitest"
import { EXPRESS_EXT_KINDS, isExpressExtKind } from "../src/index"

describe("EXPRESS_EXT_KINDS", () => {
  it("lists exactly the 5 Express extKinds", () => {
    expect(EXPRESS_EXT_KINDS).toHaveLength(5)
  })

  it("isExpressExtKind narrows for owned ids", () => {
    for (const id of EXPRESS_EXT_KINDS) {
      expect(isExpressExtKind(id)).toBe(true)
    }
  })

  it("isExpressExtKind rejects other framework prefixes", () => {
    expect(isExpressExtKind("framework:react:component")).toBe(false)
    expect(isExpressExtKind("framework:express")).toBe(false)
    expect(isExpressExtKind("framework:express:unknown")).toBe(false)
  })
})
