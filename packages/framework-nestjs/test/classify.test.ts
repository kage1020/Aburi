import { CoreError } from "@aburi/core"
import { errorFrom } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyDecorated } from "./fixtures/symbol"

describe("classifyNestjsSymbol — class decorators", () => {
  it.each([
    ["Module", "module"],
    ["Controller", "controller"],
    ["Injectable", "provider"],
    ["Catch", "filter"],
  ])("makes a class decorated @%s a %s, and flags the decorator", (name, role) => {
    expect(classifyDecorated("class", [name])).toEqual({
      extKind: `framework:nestjs:${role}`,
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:${role}`,
    })
  })

  it("gives a class the role of its first decorator, and flags every one it recognized", () => {
    expect(classifyDecorated("class", ["Injectable", "Deprecated", "Controller"])).toEqual({
      extKind: "framework:nestjs:provider",
      decoratorBoundaries: { Injectable: true, Controller: true },
      derivedBy: "framework:nestjs:provider",
    })
  })

  it.each([
    ["no decorators", []],
    ["only decorators NestJS does not define", ["SomeOtherThing"]],
  ])("returns null for a class with %s", (_label, decorators) => {
    expect(classifyDecorated("class", decorators)).toBeNull()
  })
})

describe("classifyNestjsSymbol — method decorators", () => {
  it.each([
    "Get",
    "Post",
    "Put",
    "Delete",
    "Patch",
    "Options",
    "Head",
    "All",
    "MessagePattern",
    "EventPattern",
    "SubscribeMessage",
  ])("makes a method decorated @%s a route, and flags the decorator", (name) => {
    expect(classifyDecorated("method", [name])).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:route:${name}`,
    })
  })

  it.each([
    "UseGuards",
    "UseInterceptors",
    "UsePipes",
    "UseFilters",
  ])("flags @%s as a boundary without making the method a route", (name) => {
    expect(classifyDecorated("method", [name])).toEqual({
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:handler:${name}`,
    })
  })

  it("makes a guarded method a route by its verb, and flags both decorators", () => {
    expect(classifyDecorated("method", ["UseGuards", "Post"])).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { UseGuards: true, Post: true },
      derivedBy: "framework:nestjs:route:Post",
    })
  })

  it("returns null for a method with no decorator NestJS defines", () => {
    expect(classifyDecorated("method", ["Deprecated"])).toBeNull()
  })
})

describe("classifyNestjsSymbol — other Symbol kinds", () => {
  it.each([
    "function",
    "interface",
    "type",
    "const",
    "namespace",
    "enum",
  ] as const)("returns null for a %s, even one decorated @Controller", (kind) => {
    expect(classifyDecorated(kind, ["Controller"])).toBeNull()
  })
})

describe("classifyNestjsSymbol — a decorator with an empty name", () => {
  it.each(["class", "method"] as const)("throws a CoreError naming the %s", async (kind) => {
    const error = await errorFrom(CoreError, () => classifyDecorated(kind, [""]))

    expect(error).toMatchObject({
      code: "anonymous-symbol-id-attempted",
      value: kind === "method" ? "ts:src/a.ts#C.m" : "ts:src/a.ts#C",
    })
  })
})
