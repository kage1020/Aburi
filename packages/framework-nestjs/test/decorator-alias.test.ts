import { describe, expect, it } from "vitest"
import { classifyDecorated, makeImport, NEST } from "./fixtures/symbol"

describe("classifyNestjsSymbol — a decorator renamed on import", () => {
  it.each([
    [
      "@Ctrl, imported as Controller",
      "class",
      "Ctrl",
      makeImport(NEST, ["Controller as Ctrl"]),
      {
        extKind: "framework:nestjs:controller",
        decoratorBoundaries: { Ctrl: true },
        derivedBy: "framework:nestjs:controller",
      },
    ],
    [
      "@Fetch, imported as Get",
      "method",
      "Fetch",
      makeImport(NEST, ["Get as Fetch"]),
      {
        extKind: "framework:nestjs:route",
        decoratorBoundaries: { Fetch: true },
        derivedBy: "framework:nestjs:route:Get",
      },
    ],
    [
      "@Guarded, imported as UseGuards",
      "method",
      "Guarded",
      makeImport(NEST, ["UseGuards as Guarded"]),
      { decoratorBoundaries: { Guarded: true }, derivedBy: "framework:nestjs:handler:UseGuards" },
    ],
    [
      "@OnMsg, imported from @nestjs/microservices as MessagePattern",
      "method",
      "OnMsg",
      makeImport("@nestjs/microservices", ["MessagePattern as OnMsg"]),
      {
        extKind: "framework:nestjs:route",
        decoratorBoundaries: { OnMsg: true },
        derivedBy: "framework:nestjs:route:MessagePattern",
      },
    ],
  ] as const)("classifies %s by the imported name, and flags the written one", (_label, kind, written, edge, expected) => {
    expect(classifyDecorated(kind, [written], [edge])).toEqual(expected)
  })

  it.each([
    [
      "a class whose @Controller is another module's Thing",
      "class",
      "Controller",
      makeImport("./thing", ["Thing as Controller"]),
    ],
    [
      "a method whose @Get is NestJS's Controller",
      "method",
      "Get",
      makeImport(NEST, ["Controller as Get"]),
    ],
  ] as const)("returns null for %s — the written name alone decides nothing", (_label, kind, written, edge) => {
    expect(classifyDecorated(kind, [written], [edge])).toBeNull()
  })

  it.each([
    ["a local module, at medium", "./decorators", "medium"],
    ["NestJS, at high", NEST, "high"],
  ])("reads a default-imported decorator from %s by the name the file gave it", (_label, source, confidence) => {
    const result = classifyDecorated("method", ["Get"], [makeImport(source, ["default as Get"])])

    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.confidence ?? "high").toBe(confidence)
  })

  it("resolves each file against its own import edges", () => {
    const aliased = classifyDecorated("class", ["Ctrl"], [makeImport(NEST, ["Controller as Ctrl"])])
    const unbound = classifyDecorated("class", ["Ctrl"], [])

    expect(aliased?.extKind).toBe("framework:nestjs:controller")
    expect(unbound).toBeNull()
  })
})
