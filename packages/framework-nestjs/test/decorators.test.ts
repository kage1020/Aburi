import { describe, expect, it } from "vitest"
import { classifyClassDecorator, isMethodBoundaryDecorator } from "../src/index"

describe("isMethodBoundaryDecorator", () => {
  it.each([
    ["Get", true],
    ["All", true],
    ["UseGuards", true],
    ["UseFilters", true],
    ["MessagePattern", true],
    ["SubscribeMessage", true],
    ["Controller", false],
    ["Injectable", false],
    ["Deprecated", false],
  ])("reads @%s as a method boundary: %s", (name, expected) => {
    expect(isMethodBoundaryDecorator(name)).toBe(expected)
  })
})

describe("classifyClassDecorator", () => {
  it("maps a class decorator to its extKind and the role derivedBy names", () => {
    expect(classifyClassDecorator("Injectable")).toEqual({
      extKind: "framework:nestjs:provider",
      role: "provider",
    })
  })

  it("returns undefined for a decorator that is not a class role", () => {
    expect(classifyClassDecorator("Get")).toBeUndefined()
  })
})
