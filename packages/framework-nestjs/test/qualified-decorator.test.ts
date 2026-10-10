import { decorator } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyDecorated, makeImport, makeNamespaceImport, NEST } from "./fixtures/symbol"

const nestController = decorator({ name: "Controller", qualifier: "nest" })

describe("classifyNestjsSymbol — a decorator written through a receiver", () => {
  it("resolves the receiver through a namespace import, and flags the decorator as written", () => {
    expect(
      classifyDecorated("class", [nestController], [makeNamespaceImport(NEST, "nest")]),
    ).toEqual({
      extKind: "framework:nestjs:controller",
      decoratorBoundaries: { "nest.Controller": true },
      derivedBy: "framework:nestjs:controller",
    })
  })

  it.each([
    ["a namespace import from @nestjs/common", "nest", [makeNamespaceImport(NEST, "nest")], "high"],
    [
      "a namespace import from a competing library",
      "rc",
      [makeNamespaceImport("routing-controllers", "rc")],
      "medium",
    ],
    ["a default import from @nestjs/common", "nest", [makeImport(NEST, ["nest"])], "high"],
    [
      "a default import from a competing library",
      "tsed",
      [makeImport("@tsed/common", ["tsed"])],
      "medium",
    ],
    [
      "a namespace import, though the leaf is bound by name from @nestjs/common",
      "tsed",
      [makeImport(NEST, ["Controller"], 1), makeNamespaceImport("@tsed/common", "tsed", 2)],
      "medium",
    ],
    [
      "a nested receiver whose first segment a competing library binds",
      "ns.deep",
      [makeNamespaceImport("routing-controllers", "ns")],
      "medium",
    ],
    [
      "both kinds of edge, the namespace one from @nestjs/common",
      "nest",
      [makeNamespaceImport(NEST, "nest", 1), makeImport("@tsed/common", ["nest"], 2)],
      "high",
    ],
    [
      "a namespace bound twice, the NestJS edge first",
      "ns",
      [makeNamespaceImport(NEST, "ns", 1), makeNamespaceImport("routing-controllers", "ns", 2)],
      "high",
    ],
    [
      "a namespace bound twice, the NestJS edge second",
      "ns",
      [makeNamespaceImport("routing-controllers", "ns", 1), makeNamespaceImport(NEST, "ns", 2)],
      "high",
    ],
    ["nothing the edges mention", "local", [makeNamespaceImport(NEST, "nest")], "high"],
    ["a namespace edge that binds no name", "nest", [makeImport(NEST, "*")], "high"],
    [
      "nothing, though the leaf is bound by name from @nestjs/common",
      "tsed",
      [makeImport(NEST, ["Controller"])],
      "high",
    ],
  ])("trusts a qualified @Controller as far as %s allows", (_label, qualifier, imports, confidence) => {
    const result = classifyDecorated(
      "class",
      [decorator({ name: "Controller", qualifier })],
      imports,
    )

    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence ?? "high").toBe(confidence)
  })

  it("names a qualified route after its leaf, which a namespace import cannot rename", () => {
    expect(
      classifyDecorated(
        "method",
        [decorator({ name: "Get", qualifier: "nest" })],
        [makeNamespaceImport(NEST, "nest")],
      ),
    ).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { "nest.Get": true },
      derivedBy: "framework:nestjs:route:Get",
    })
  })

  it("takes a method's confidence from its route decorator across the two forms", () => {
    const result = classifyDecorated(
      "method",
      [
        decorator({ name: "Get", qualifier: "tsed", line: 1 }),
        decorator({ name: "UseGuards", line: 2 }),
      ],
      [makeNamespaceImport("@tsed/common", "tsed", 1), makeImport(NEST, ["UseGuards"], 2)],
    )

    expect(result).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { "tsed.Get": true, UseGuards: true },
      derivedBy: "framework:nestjs:route:Get",
      confidence: "medium",
    })
  })

  it("keys a boundary on the written form, so a shared leaf does not flag both decorators", () => {
    const result = classifyDecorated(
      "class",
      ["Ctrl", decorator({ name: "Ctrl", qualifier: "x", line: 2 })],
      [makeImport(NEST, ["Controller as Ctrl"])],
    )

    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.decoratorBoundaries).toEqual({ Ctrl: true })
  })
})
