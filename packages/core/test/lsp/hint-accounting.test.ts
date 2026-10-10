import { symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol, LspEnrichmentStats, LspHintRejections } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
import {
  createStatsBuilder,
  type EnrichmentResult,
  finalizeStats,
  type LspProducerStats,
  type ReceiverHint,
  withHintUsage,
} from "../../src/lsp"
import { makeSymbol } from "../fixtures/ir"
import { enrich, makeClassSymbol, makeMethodSymbol, thisFooFile } from "./fixtures/enrichment-ctx"
import { hoverPosition, hoverServer } from "./fixtures/mock-server"

function noRejections(overrides: Partial<LspHintRejections> = {}): LspHintRejections {
  return {
    unparseableHover: 0,
    ownerClassNotFound: 0,
    memberNotFound: 0,
    kindMismatch: 0,
    targetDropped: 0,
    ...overrides,
  }
}

function statsOf(enrichment: EnrichmentResult): LspProducerStats {
  if (enrichment.stats === undefined)
    throw new Error("expected the enrichment pass to report stats")
  return enrichment.stats
}

function resolveWith(symbols: IRSymbol[], receiverHints: ReadonlyMap<string, ReceiverHint>) {
  return resolveCallGraph({ symbols, importsByFile: new Map(), receiverHints })
}

describe("what the enrichment pass counts", () => {
  it("counts a hint it wrote, and nothing else", async () => {
    const enrichment = await enrich({
      ...thisFooFile(),
      serverFactory: hoverServer(() => ({ contents: "(method) C.foo(): void" })),
    })

    expect(enrichment.receiverHints.size).toBe(1)
    expect(statsOf(enrichment).hintsProduced).toBe(1)
    expect(statsOf(enrichment).hintsRejected).toEqual(noRejections())
  })

  it.each<[string, unknown, keyof LspHintRejections, IRSymbol[]?]>([
    ["a hover that answers nothing", null, "unparseableHover"],
    [
      "a hover whose contents carry no text",
      { contents: { kind: "markdown" } },
      "unparseableHover",
    ],
    [
      "hover text naming no owner class",
      { contents: "function foo(): void" },
      "ownerClassNotFound",
    ],
    [
      "hover text naming a class the Symbol table lacks",
      { contents: "(method) Elsewhere.foo(): void" },
      "ownerClassNotFound",
    ],
    [
      "a known class whose member the Symbol table lacks",
      { contents: "(method) C.foo(): void" },
      "memberNotFound",
      thisFooFile().symbols.filter((s) => s.id !== "ts:src/a.ts#C.foo"),
    ],
  ])("rejects %s as %s while every request counter says the run went well", async (_, hover, bucket, symbols) => {
    const enrichment = await enrich({
      ...thisFooFile(),
      ...(symbols === undefined ? {} : { symbols }),
      serverFactory: hoverServer(() => hover),
    })

    expect(statsOf(enrichment)).toMatchObject({
      hintsProduced: 0,
      hintsRejected: noRejections({ [bucket]: 1 }),
      requestsFailed: 0,
      requestsTimedOut: 0,
      filesEnriched: 1,
      filesFellBack: 0,
    })
  })

  it("accounts for every hover that came back, in exactly one place", async () => {
    const answers = new Map<number, unknown>([
      [4, { contents: "(method) C.foo(): void" }],
      [5, { contents: "(method) C.gone(): void" }],
      [7, { contents: "function foo(): void" }],
    ])
    const hovered: number[] = []

    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [
          { target: "this.foo", line: 4 },
          { target: "this.gone", line: 5 },
          { target: "this.foo", line: 6 },
          { target: "this.foo", line: 7 },
        ]),
      ],
      fileContents: {
        "src/a.ts":
          "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.gone()\n    this.foo()\n    this.foo()\n  }\n}",
      },
      serverFactory: hoverServer((params) => {
        const line = hoverPosition(params).line + 1
        hovered.push(line)
        return answers.get(line) ?? null
      }),
    })

    expect(hovered.sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
    expect(statsOf(enrichment).hintsProduced).toBe(1)
    expect(statsOf(enrichment).hintsRejected).toEqual(
      noRejections({ memberNotFound: 1, unparseableHover: 1, ownerClassNotFound: 1 }),
    )
  })
})

describe("what the resolver counts", () => {
  it("counts nothing when the untyped tier got there first", () => {
    const callee = makeSymbol("ts:src/a.ts#helper")
    const untypedCaller = makeSymbol("ts:src/a.ts#caller", {
      calls: [{ target: "helper", line: 4, resolved: null }],
    })

    const result = resolveWith(
      [untypedCaller, callee],
      new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "helper"),
          { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Nope.foo") },
        ],
      ]),
    )

    expect(result.symbols[0]?.calls[0]?.resolved).toBe(callee.id)
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 0 })
  })

  it("counts call sites, not hints: two identical calls on one line consume one hint twice", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [
          { target: "this.foo", line: 4 },
          { target: "this.foo", line: 4 },
        ]),
      ],
      fileContents: {
        "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo(); this.foo()\n  }\n}",
      },
      serverFactory: hoverServer(() => ({ contents: "(method) C.foo(): void" })),
    })

    expect(enrichment.receiverHints.size).toBe(1)
    expect(resolveWith(enrichment.symbols, enrichment.receiverHints).lspHintUsage).toEqual({
      consumed: 2,
      kindMismatch: 0,
      targetDropped: 0,
    })
  })

  it("counts a hint and a consumption for each receiver on a shared line", async () => {
    const line = "    this.foo(super.foo())"
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "Base", 1),
        makeMethodSymbol("src/a.ts", "Base", "foo", 2),
        makeClassSymbol("src/a.ts", "Sub", 4),
        makeMethodSymbol("src/a.ts", "Sub", "foo", 5),
        makeMethodSymbol("src/a.ts", "Sub", "bar", 6, [
          { target: "super.foo", line: 7 },
          { target: "this.foo", line: 7 },
        ]),
      ],
      fileContents: {
        "src/a.ts": `class Base {\n  foo() {}\n}\n\nclass Sub extends Base {\n  bar() {\n${line}\n  }\n  foo() {}\n}`,
      },
      serverFactory: hoverServer((params) => ({
        contents:
          hoverPosition(params).character === line.indexOf("this.") + "this.".length
            ? "(method) Sub.foo(): void"
            : "(method) Base.foo(): void",
      })),
    })

    expect(statsOf(enrichment).hintsProduced).toBe(2)
    const result = resolveWith(enrichment.symbols, enrichment.receiverHints)
    expect(result.lspHintUsage).toEqual({ consumed: 2, kindMismatch: 0, targetDropped: 0 })
    expect(result.edges.map((e) => e.to).sort()).toEqual([
      "ts:src/a.ts#Base.foo",
      "ts:src/a.ts#Sub.foo",
    ])
  })
})

describe("the folded record", () => {
  it("reports an all-rejected scan as all-rejected, identically on a rerun", async () => {
    const run = async (): Promise<LspEnrichmentStats> => {
      const enrichment = await enrich({
        symbols: [
          makeClassSymbol("src/a.ts", "C", 1),
          makeSymbol("ts:src/a.ts#C.foo", { kind: "method", dropped: true }),
          makeMethodSymbol("src/a.ts", "C", "bar", 3, [
            { target: "this.foo", line: 4 },
            { target: "this.foo", line: 5 },
          ]),
        ],
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n  }\n}",
        },
        serverFactory: hoverServer(async () => {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)))
          return { contents: "(method) C.foo(): void" }
        }),
      })
      const result = resolveWith(enrichment.symbols, enrichment.receiverHints)
      expect(result.stats.unresolved.dynamic).toBe(2)
      return withHintUsage(statsOf(enrichment), result.lspHintUsage)
    }

    const first = await run()
    expect(first).toMatchObject({
      hintsProduced: 2,
      hintsConsumed: 0,
      hintsRejected: noRejections({ targetDropped: 2 }),
    })
    expect(await run()).toEqual(first)
  })

  it("folds the resolver's half in additively, without disturbing the producer's", () => {
    const producer: LspProducerStats = {
      ...finalizeStats(createStatsBuilder(true)),
      hintsProduced: 7,
      hintsRejected: noRejections({ unparseableHover: 3 }),
    }

    const once = withHintUsage(producer, { consumed: 2, kindMismatch: 1, targetDropped: 4 })
    expect(once).toMatchObject({
      hintsProduced: 7,
      hintsConsumed: 2,
      hintsRejected: noRejections({ unparseableHover: 3, kindMismatch: 1, targetDropped: 4 }),
    })

    const twice = withHintUsage(
      { ...producer, ...once, hintsRejected: once.hintsRejected ?? noRejections() },
      { consumed: 1, kindMismatch: 0, targetDropped: 1 },
    )
    expect(twice).toMatchObject({
      hintsConsumed: 3,
      hintsRejected: noRejections({ unparseableHover: 3, kindMismatch: 1, targetDropped: 5 }),
    })
  })
})
