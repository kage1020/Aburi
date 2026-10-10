import { describe, expect, it } from "vitest"
import { EXPRESS_EXT_KINDS, isExpressExtKind } from "../src/index"

describe("EXPRESS_EXT_KINDS", () => {
  it("lists exactly the Express extKinds", () => {
    expect(EXPRESS_EXT_KINDS).toEqual([
      "framework:express:router",
      "framework:express:route",
      "framework:express:middleware",
      "framework:express:error-middleware",
      "framework:express:mount",
    ])
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
