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

  describe("a head bound to a declaration whose members are Symbols is where the resolver stops", () => {
    interface BindingCase extends Omit<ScopeCase, "callees"> {
      declaration: IRSymbol
    }

    const FIELDS_ONLY = { kind: "class", dropped: true, dropReason: "pure DTO" } as const
    const baseLogger = makeSymbol("ts:src/base.ts#Logger", { kind: "class" })
    const BINDINGS: BindingCase[] = [
      {
        scope: "a class declared in the caller's file",
        target: "Logger.log",
        declaration: makeSymbol("ts:src/a.ts#Logger", { kind: "class" }),
      },
      {
        scope: "a dropped class of fields declared in the caller's file",
        target: "Logger.log",
        declaration: makeSymbol("ts:src/a.ts#Logger", FIELDS_ONLY),
      },
      {
        scope: "a namespace declared in the caller's file",
        target: "Logger.log",
        declaration: makeSymbol("ts:src/a.ts#Logger", { kind: "namespace" }),
      },
      {
        scope: "an object literal the caller's file binds",
        target: "Logger.log",
        declaration: makeSymbol("ts:src/a.ts#Logger", {
          kind: "const",
          derivedBy: ["object-literal-initializer"],
        }),
      },
      {
        scope: "a named import of a class its module declares",
        target: "Logger.log",
        declaration: baseLogger,
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["Logger"] }),
      },
      {
        scope: "a named import of a dropped class of fields its module declares",
        target: "Logger.log",
        declaration: makeSymbol("ts:src/base.ts#Logger", FIELDS_ONLY),
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["Logger"] }),
      },
      {
        scope: "a renamed import of a class its module declares",
        target: "Base.log",
        declaration: baseLogger,
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["Logger as Base"] }),
      },
      {
        scope: "a default import of the class its module exports as default",
        target: "Base.log",
        declaration: makeSymbol("ts:src/base.ts#Logger", {
          kind: "class",
          derivedBy: ["export-default"],
        }),
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["default as Base"] }),
      },
      {
        scope: "a namespace import of a module that declares the class",
        target: "base.Logger.log",
        declaration: baseLogger,
        imports: importsOf("src/a.ts", {
          source: "./base",
          symbols: "*",
          namespaceBinding: "base",
        }),
      },
    ]

    // Two, so a search that went on past the binding would end `ambiguous` rather than `no-match`.
    const namesakes = (target: string, component: string) =>
      ["audit-log", "trace-log"].map((file) =>
        makeSymbol(`ts:src/${file}.ts#${target}`, { kind: "method", component }),
      )

    describe.each([
      ["the caller's component", "billing"],
      ["another component", "reporting"],
    ])("over same-named members in %s", (_elsewhere, component) => {
      it.each(
        BINDINGS,
      )("leaves a call through $scope unresolved, bucketed `no-match`, when it lacks the member", (c) => {
        const result = resolveFromBilling({
          ...c,
          callees: [c.declaration, ...namesakes(c.target, component)],
        })
        expect(result.edges).toEqual([])
        expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
        expect(result.diagnostics.map((d) => [d.bucket, d.candidates])).toEqual([["no-match", []]])
      })
    })

    it.each(BINDINGS)("reaches the member through $scope when it declares it", (c) => {
      const member = makeSymbol(`${c.declaration.id}.log`, { kind: "method" })
      const result = resolveFromBilling({
        ...c,
        callees: [c.declaration, member, ...namesakes(c.target, "billing")],
      })
      expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([[member.id, "high"]])
    })

    it.each<ScopeCase & { bucket: string }>([
      {
        scope: "an alias of a name its module only re-exports",
        target: "Base.log",
        callees: [makeSymbol("ts:src/barrel.ts#other")],
        imports: importsOf("src/a.ts", { source: "./barrel", symbols: ["Logger as Base"] }),
        bucket: "no-match",
      },
      {
        scope: "an alias imported from a module the scan has no Symbol in",
        target: "Base.log",
        callees: [],
        imports: importsOf("src/a.ts", { source: "./barrel", symbols: ["Logger as Base"] }),
        bucket: "no-match",
      },
      {
        scope: "a default import of a module whose only `Logger` is a named export",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/barrel.ts#Logger", { kind: "class" })],
        imports: importsOf("src/a.ts", { source: "./barrel", symbols: ["default as Logger"] }),
        bucket: "no-match",
      },
      {
        scope: "a default import of an anonymous class",
        target: "Base.run",
        callees: [makeSymbol("ts:src/base.ts#<default>", { kind: "class" })],
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["default as Base"] }),
        bucket: "no-match",
      },
      {
        scope: "a namespace import of a module that only re-exports the name",
        target: "barrel.Logger.log",
        callees: [makeSymbol("ts:src/barrel.ts#other")],
        imports: importsOf("src/a.ts", {
          source: "./barrel",
          symbols: "*",
          namespaceBinding: "barrel",
        }),
        bucket: "no-match",
      },
      {
        scope: "a namespace import of a bare specifier",
        target: "logging.Logger.log",
        callees: [],
        imports: importsOf("src/a.ts", {
          source: "@acme/logging",
          symbols: "*",
          namespaceBinding: "logging",
        }),
        bucket: "external",
      },
    ])("ends the search at $scope, since the target does not spell the declaration's name", (c) => {
      const result = resolveFromBilling({
        ...c,
        callees: [...c.callees, ...namesakes(c.target, "billing")],
      })
      expect(result.edges).toEqual([])
      expect(result.diagnostics.map((d) => [d.bucket, d.candidates])).toEqual([[c.bucket, []]])
    })

    it.each<ScopeCase>([
      {
        scope: "a const the caller's file declares with a value it cannot see",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/a.ts#Logger", { kind: "const" })],
      },
      {
        scope: "a destructured binding",
        target: "Logger.log",
        callees: [
          makeSymbol("ts:src/a.ts#Logger", { kind: "const", derivedBy: ["destructured-binding"] }),
        ],
      },
      {
        scope: "an ambient class",
        target: "Logger.log",
        callees: [
          makeSymbol("ts:src/a.ts#Logger", { kind: "class", derivedBy: ["ambient-declaration"] }),
        ],
      },
      {
        scope: "a function the caller's file declares",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/a.ts#Logger")],
      },
      {
        scope: "an interface the caller's file declares",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/a.ts#Logger", { kind: "interface", dropped: true })],
      },
      {
        scope: "two top-level Symbols of that name in the caller's file",
        target: "Logger.log",
        callees: [
          makeSymbol("ts:src/a.ts#Logger", { kind: "class" }),
          makeSymbol("ts:src/a.ts#Logger.second", { name: "Logger", kind: "class" }),
        ],
      },
      {
        scope: "a named import from a bare specifier",
        target: "Logger.log",
        callees: [],
        imports: importsOf("src/a.ts", { source: "@acme/logging", symbols: ["Logger"] }),
      },
      {
        scope: "a named import of a name its module only re-exports",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/barrel.ts#other")],
        imports: importsOf("src/a.ts", { source: "./barrel", symbols: ["Logger"] }),
      },
      {
        scope: "a named import from a module the scan has no Symbol in",
        target: "Logger.log",
        callees: [],
        imports: importsOf("src/a.ts", { source: "./barrel", symbols: ["Logger"] }),
      },
      {
        scope: "a named import of a const with a value its module cannot see",
        target: "Logger.log",
        callees: [makeSymbol("ts:src/base.ts#Logger", { kind: "const" })],
        imports: importsOf("src/a.ts", { source: "./base", symbols: ["Logger"] }),
      },
    ])("still searches the caller's component past $scope", (scopeCase) => {
      const inComponent = makeSymbol(`ts:src/audit-log.ts#${scopeCase.target}`, {
        kind: "method",
        component: "billing",
      })
      const result = resolveFromBilling({
        ...scopeCase,
        callees: [...scopeCase.callees, inComponent],
      })
      expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
        [inComponent.id, "medium"],
      ])
    })
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
