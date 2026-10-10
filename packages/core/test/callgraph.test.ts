import { importEdge, symbolId } from "@aburi/test-support"
import type { Confidence, ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { makeLanguageId } from "../src/id"
import { importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

interface ScopeCase {
  scope: string
  target: string
  callees: IRSymbol[]
  imports?: ReadonlyMap<string, readonly ImportEdge[]>
}

function resolveFromBilling({ target, callees, imports = NO_IMPORTS }: ScopeCase) {
  const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 5 }], { component: "billing" })
  return resolveCallGraph({ symbols: [caller, ...callees], importsByFile: imports })
}

describe("resolveCallGraph", () => {
  it("reports an empty workspace as no edges, no diagnostics and zeroed stats", () => {
    const result = resolveCallGraph({ symbols: [], importsByFile: NO_IMPORTS })
    expect(result.symbols).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.stats).toEqual({
      totalCalls: 0,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
    })
  })

  it("hands back a Symbol that makes no calls as it was", () => {
    const quiet = makeSymbol("ts:src/a.ts#quiet")
    const result = resolveCallGraph({ symbols: [quiet], importsByFile: NO_IMPORTS })
    expect(result.symbols).toEqual([quiet])
    expect(result.edges).toEqual([])
  })

  it.each<ScopeCase & { to: string; confidence: Confidence }>([
    {
      scope: "the caller's own file",
      target: "helper",
      callees: [makeSymbol("ts:src/a.ts#helper")],
      to: "ts:src/a.ts#helper",
      confidence: "high",
    },
    {
      scope: "a relative import",
      target: "helper",
      callees: [makeSymbol("ts:src/util.ts#helper")],
      imports: importsOf("src/a.ts", { source: "./util", symbols: ["helper"] }),
      to: "ts:src/util.ts#helper",
      confidence: "high",
    },
    {
      scope: "the caller's component",
      target: "Pricing.calc",
      callees: [makeSymbol("ts:src/p.ts#Pricing.calc", { kind: "method", component: "billing" })],
      to: "ts:src/p.ts#Pricing.calc",
      confidence: "medium",
    },
    {
      scope: "another component, through the workspace",
      target: "Pricing.calc",
      callees: [makeSymbol("ts:src/p.ts#Pricing.calc", { kind: "method", component: "api" })],
      to: "ts:src/p.ts#Pricing.calc",
      confidence: "low",
    },
  ])("resolves a callee found in $scope at $confidence confidence", (scopeCase) => {
    const { target, to, confidence } = scopeCase
    const result = resolveFromBilling(scopeCase)
    expect(result.edges).toEqual([
      { from: "ts:src/a.ts#caller", to, via: "call", confidence, line: 5 },
    ])
    expect(result.symbols[0]?.calls).toEqual([{ target, line: 5, resolved: to }])
  })

  it("searches the component-less Symbols as one component for a caller outside any component", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Pricing.calc", line: 5 }])
    const callee = makeSymbol("ts:src/p.ts#Pricing.calc", { kind: "method" })
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: NO_IMPORTS })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      ["ts:src/p.ts#Pricing.calc", "medium"],
    ])
  })

  it.each<ScopeCase & { to: string }>([
    {
      scope: "the caller's file over an import",
      target: "helper",
      callees: [makeSymbol("ts:src/a.ts#helper"), makeSymbol("ts:src/util.ts#helper")],
      imports: importsOf("src/a.ts", { source: "./util", symbols: ["helper"] }),
      to: "ts:src/a.ts#helper",
    },
    {
      scope: "an import over the caller's component",
      target: "Cls.method",
      callees: [
        makeSymbol("ts:src/x.ts#Cls", { kind: "class", component: "billing" }),
        makeSymbol("ts:src/x.ts#Cls.method", { kind: "method", component: "billing" }),
        makeSymbol("ts:src/y.ts#Cls.method", { kind: "method", component: "billing" }),
      ],
      imports: importsOf("src/a.ts", { source: "./x", symbols: ["Cls"] }),
      to: "ts:src/x.ts#Cls.method",
    },
    {
      scope: "the caller's component over the workspace",
      target: "Cls.method",
      callees: [
        makeSymbol("ts:src/near.ts#Cls.method", { kind: "method", component: "billing" }),
        makeSymbol("ts:src/far.ts#Cls.method", { kind: "method", component: "reporting" }),
      ],
      to: "ts:src/near.ts#Cls.method",
    },
  ])("takes the nearer scope when two would match: $scope", (scopeCase) => {
    expect(resolveFromBilling(scopeCase).edges.map((edge) => edge.to)).toEqual([scopeCase.to])
  })

  it.each<ScopeCase>([
    {
      scope: "a bare name declared in another file, not imported",
      target: "helper",
      callees: [makeSymbol("ts:src/b.ts#helper", { component: "billing" })],
    },
    {
      scope: "a qualified name declared only in another language",
      target: "Uniq.method",
      callees: [
        makeSymbol("py:src/other.py#Uniq.method", {
          kind: "method",
          language: makeLanguageId("py"),
          component: "billing",
        }),
      ],
    },
  ])("leaves unresolved $scope", (scopeCase) => {
    expect(resolveFromBilling(scopeCase).edges).toEqual([])
  })

  it.each<ScopeCase>([
    {
      scope: "by name in the caller's file",
      target: "helper",
      callees: [makeSymbol("ts:src/a.ts#helper", { dropped: true, dropReason: "test" })],
    },
    {
      scope: "as a member in the caller's file",
      target: "Cls.method",
      callees: [
        makeSymbol("ts:src/a.ts#Cls", { kind: "class" }),
        makeSymbol("ts:src/a.ts#Cls.method", { kind: "method", dropped: true, dropReason: "test" }),
      ],
    },
    {
      scope: "through an import",
      target: "helper",
      callees: [makeSymbol("ts:src/util.ts#helper", { dropped: true, dropReason: "test" })],
      imports: importsOf("src/a.ts", { source: "./util", symbols: ["helper"] }),
    },
    {
      scope: "in the caller's component",
      target: "Pricing.calc",
      callees: [
        makeSymbol("ts:src/p.ts#Pricing.calc", {
          kind: "method",
          component: "billing",
          dropped: true,
          dropReason: "test",
        }),
      ],
    },
    {
      scope: "in another component",
      target: "Pricing.calc",
      callees: [
        makeSymbol("ts:src/p.ts#Pricing.calc", {
          kind: "method",
          component: "reporting",
          dropped: true,
          dropReason: "test",
        }),
      ],
    },
  ])("never resolves to a dropped Symbol found $scope", (scopeCase) => {
    const result = resolveFromBilling(scopeCase)
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("emits one edge per call site when the same callee is invoked on several lines", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "helper", line: 3 },
      { target: "helper", line: 7 },
    ])
    const callee = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: NO_IMPORTS })
    expect(result.edges.map((e) => e.line)).toEqual([3, 7])
  })

  it("sorts edges by (from, to, line) whatever order the Symbols arrive in", () => {
    const symbols = [
      withCalls("ts:src/z.ts#z", [
        { target: "other", line: 8 },
        { target: "helper", line: 3 },
      ]),
      withCalls("ts:src/a.ts#a", [{ target: "helper", line: 12 }]),
      makeSymbol("ts:src/util.ts#helper"),
      makeSymbol("ts:src/util.ts#other"),
    ]
    const importsByFile = new Map<string, readonly ImportEdge[]>([
      ["src/z.ts", [importEdge({ source: "./util", symbols: ["helper", "other"] })]],
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const forward = resolveCallGraph({ symbols, importsByFile })
    const reversed = resolveCallGraph({ symbols: [...symbols].reverse(), importsByFile })
    expect(forward.edges.map((e) => `${e.from}->${e.to}@${e.line}`)).toEqual([
      "ts:src/a.ts#a->ts:src/util.ts#helper@12",
      "ts:src/z.ts#z->ts:src/util.ts#helper@3",
      "ts:src/z.ts#z->ts:src/util.ts#other@8",
    ])
    expect(reversed.edges).toEqual(forward.edges)
  })

  it.each([
    ["a Symbol in the caller's file by that name", "helper", new Map()],
    [
      "a receiver hint naming another target",
      "this.helper",
      new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.helper"),
          { kind: "this" as const, targetSymbolId: symbolId("ts:src/a.ts#Svc.other") },
        ],
      ]),
    ],
  ])("keeps a call that arrived resolved, despite %s, and emits no edge for it", (_despite, target, receiverHints) => {
    const caller = makeSymbol("ts:src/a.ts#Svc.run", {
      calls: [{ target, line: 4, resolved: "ts:src/x.ts#elsewhere" }],
    })
    const result = resolveCallGraph({
      symbols: [
        caller,
        makeSymbol("ts:src/a.ts#helper"),
        makeSymbol("ts:src/a.ts#Svc.other", { kind: "method" }),
      ],
      importsByFile: NO_IMPORTS,
      receiverHints,
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBe("ts:src/x.ts#elsewhere")
    expect(result.edges).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.stats.resolvedCalls).toBe(1)
  })
})
