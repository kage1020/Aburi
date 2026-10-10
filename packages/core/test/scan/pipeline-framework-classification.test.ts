import type { Confidence, FrameworkPlugin, ImportEdge, SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { extractOneSymbol, stubCandidate, stubFrameworkPlugin } from "../fixtures/plugins"

function classifying(name: string, extKind: string, derivedBy = `${name}:hit`): FrameworkPlugin {
  return stubFrameworkPlugin(name, { classifySymbol: () => ({ extKind, derivedBy }) })
}

function dropping(name: string, reason = name): FrameworkPlugin {
  return stubFrameworkPlugin(name, { symbolDropHint: () => ({ reason, category: "B" }) })
}

describe("runFilePipeline — framework classification", () => {
  it("takes the first framework's classification and asks no later one", async () => {
    const asked: string[] = []
    const second = stubFrameworkPlugin("framework-second", {
      classifySymbol: () => {
        asked.push("framework-second")
        return { extKind: "framework:second:role", derivedBy: "framework-second:hit" }
      },
    })

    const { symbols } = await extractOneSymbol({
      frameworks: [classifying("framework-first", "framework:first:role"), second],
    })

    expect(symbols[0]?.extKind).toBe("framework:first:role")
    expect(symbols[0]?.derivedBy).toEqual(["framework-first:hit"])
    expect(asked).toEqual([])
  })

  it("falls through a framework that classifies nothing to the next", async () => {
    const { symbols } = await extractOneSymbol({
      frameworks: [
        stubFrameworkPlugin("framework-null"),
        classifying("framework-hit", "framework:hit:role"),
      ],
    })
    expect(symbols[0]?.extKind).toBe("framework:hit:role")
  })

  it("hands the classifier the file's import edges", async () => {
    const seen: (readonly ImportEdge[])[] = []
    const watching = stubFrameworkPlugin("framework-imports", {
      classifySymbol: (_symbol, ctx) => {
        seen.push(ctx.imports)
        return null
      },
    })
    const imports: ImportEdge[] = [
      { source: "@nestjs/common", symbols: ["Controller as Ctrl"], line: 1, dynamic: false },
    ]

    const result = await extractOneSymbol({ frameworks: [watching], imports })

    // The very array, not a copy: a plugin may memoize per file on its identity.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(result.imports)
  })

  it("marks the decorator the winning classification names as a boundary", async () => {
    const candidate = stubCandidate("Fn", {
      decorators: [
        { name: "Controller", raw: "@Controller()", arguments: [], boundary: false, line: 1 },
        { name: "Injectable", raw: "@Injectable()", arguments: [], boundary: false, line: 2 },
      ],
    })
    const framework = stubFrameworkPlugin("framework-boundary", {
      classifySymbol: () => ({
        extKind: "framework:hit:controller",
        decoratorBoundaries: { Controller: true },
        derivedBy: "framework-boundary:hit",
      }),
    })

    const { symbols } = await extractOneSymbol({ candidate, frameworks: [framework] })

    expect(symbols[0]?.decorators.map((d) => [d.name, d.boundary])).toEqual([
      ["Controller", true],
      ["Injectable", false],
    ])
  })

  it("splits a `;`-joined derivedBy into entries, without repeating one the candidate has", async () => {
    const candidate = stubCandidate("Fn", { derivedBy: ["framework:next:page"] })
    const framework = classifying(
      "framework-compound",
      "framework:next:page",
      "framework:next:page;framework:next:client-component",
    )

    const { symbols } = await extractOneSymbol({ candidate, frameworks: [framework] })

    expect(symbols[0]?.derivedBy).toEqual([
      "framework:next:page",
      "framework:next:client-component",
    ])
  })

  it.each<[string, readonly FrameworkPlugin[], Confidence]>([
    [
      "the winning classifier's confidence",
      [
        stubFrameworkPlugin("framework-medium", {
          classifySymbol: () => ({
            extKind: "framework:express:middleware",
            derivedBy: "framework-medium:hit",
            confidence: "medium",
          }),
        }),
      ],
      "medium",
    ],
    ["high when no framework classifies", [], "high"],
    [
      "high when the winning classifier states none",
      [classifying("framework-silent", "framework:nestjs:controller")],
      "high",
    ],
  ])("gives the Symbol %s", async (_label, frameworks, confidence) => {
    const { symbols } = await extractOneSymbol({ frameworks })
    expect(symbols[0]?.confidence).toBe(confidence)
  })
})

describe("runFilePipeline — drop decisions", () => {
  it("asks a framework that did not classify the Symbol, and shows it the winning classification", async () => {
    const seen: (string | null)[] = []
    const dropper = stubFrameworkPlugin("framework-dropper", {
      symbolDropHint: (symbol) => {
        seen.push(symbol.extKind)
        return { reason: "dropper says so", category: "B" }
      },
    })

    const { symbols } = await extractOneSymbol({
      frameworks: [classifying("framework-classifier", "framework:first:role"), dropper],
    })

    expect(seen).toEqual(["framework:first:role"])
    expect(symbols[0]?.dropped).toBe(true)
    expect(symbols[0]?.dropReason).toBe("dropper says so")
  })

  it.each<[string, SymbolCandidate, readonly FrameworkPlugin[], string | null]>([
    [
      "the core shape rules ahead of every plugin",
      stubCandidate("Shape", { kind: "interface" }),
      [dropping("framework-a")],
      "interface (data model)",
    ],
    [
      "the first framework, in list order",
      stubCandidate("Fn"),
      [dropping("framework-a"), dropping("framework-b")],
      "framework-a",
    ],
    [
      "a framework ahead of the language plugin",
      stubCandidate("Fn"),
      [dropping("framework-a")],
      "framework-a",
    ],
    [
      "the language plugin when no framework drops it",
      stubCandidate("Fn"),
      [stubFrameworkPlugin()],
      "language",
    ],
  ])("takes the drop reason from %s", async (_label, candidate, frameworks, reason) => {
    const { symbols } = await extractOneSymbol({
      candidate,
      frameworks,
      language: { symbolDropHint: () => ({ reason: "language", category: "B" }) },
    })
    expect(symbols[0]?.dropReason).toBe(reason)
  })

  it("keeps the Symbol when no rule and no plugin drops it", async () => {
    const keeping = stubFrameworkPlugin("framework-keeps", { symbolDropHint: () => null })
    const { symbols } = await extractOneSymbol({ frameworks: [keeping] })
    expect(symbols[0]?.dropped).toBe(false)
    expect(symbols[0]?.dropReason).toBeNull()
  })
})
