import type { ImportEdge, Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { importsOf, params, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

interface CallSetup {
  callees?: IRSymbol[]
  imports?: ReadonlyMap<string, readonly ImportEdge[]>
  signature?: Signature
  dynamicReceiver?: boolean
}

interface UnresolvedCase extends CallSetup {
  cause: string
  target: string
}

function resolveOneCall(target: string, setup: CallSetup = {}) {
  const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 4 }], {
    component: "billing",
    signature: setup.signature ?? null,
  })
  return resolveCallGraph({
    symbols: [caller, ...(setup.callees ?? [])],
    importsByFile: setup.imports ?? NO_IMPORTS,
    dynamicCallSites: new Set(
      setup.dynamicReceiver === true ? [makeCallSiteKey("src/a.ts", 4, target)] : [],
    ),
  })
}

function competingSaves(): IRSymbol[] {
  return [
    makeSymbol("ts:src/z.ts#User.save", { kind: "method", component: "billing" }),
    makeSymbol("ts:src/b.ts#User.save", { kind: "method", component: "billing" }),
  ]
}

describe("unresolved calls are bucketed by cause", () => {
  it.each<UnresolvedCase>([
    { cause: "a callee that exists nowhere", target: "typoed" },
    {
      cause: "a relative import that misses",
      target: "helper",
      imports: importsOf("src/a.ts", { source: "./b", symbols: ["helper"] }),
    },
    {
      cause: "a `.` import that misses",
      target: "helper",
      imports: importsOf("src/a.ts", { source: ".", symbols: ["helper"] }),
    },
    {
      cause: "a dynamic import of a bare specifier",
      target: "sortBy",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"], dynamic: true }),
    },
  ])("`no-match` for $cause", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it("`no-match` for a `..` that climbs above the workspace root, rather than a clamp to the root index", () => {
    const caller = withCalls("ts:a.ts#caller", [{ target: "helper", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller, makeSymbol("ts:index.ts#helper")],
      importsByFile: importsOf("a.ts", { source: "..", symbols: ["helper"] }),
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it.each<UnresolvedCase>([
    {
      cause: "a named import",
      target: "sortBy",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"] }),
    },
    {
      cause: "a namespace import",
      target: "lodash.sortBy",
      imports: importsOf("src/a.ts", {
        source: "lodash",
        symbols: "*",
        namespaceBinding: "lodash",
      }),
    },
    {
      cause: "a default import, by its local binding",
      target: "React.createElement",
      imports: importsOf("src/a.ts", { source: "react", symbols: ["default as React"] }),
    },
    {
      cause: "an aliased import, by its local binding",
      target: "sort",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy as sort"] }),
    },
  ])("`external` for $cause from a bare specifier", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it.each<UnresolvedCase & { candidates: string[] }>([
    {
      cause: "two top-level Symbols of that name in the caller's file",
      target: "helper",
      callees: [
        makeSymbol("ts:src/a.ts#helper.overload", { name: "helper" }),
        makeSymbol("ts:src/a.ts#helper"),
      ],
      candidates: ["ts:src/a.ts#helper", "ts:src/a.ts#helper.overload"],
    },
    {
      cause: "two imports binding that name",
      target: "helper",
      callees: [makeSymbol("ts:src/two.ts#helper"), makeSymbol("ts:src/one.ts#helper")],
      imports: importsOf(
        "src/a.ts",
        { source: "./two", symbols: ["helper"] },
        { source: "./one", symbols: ["helper"] },
      ),
      candidates: ["ts:src/one.ts#helper", "ts:src/two.ts#helper"],
    },
    {
      cause: "two Symbols of that name in the caller's component",
      target: "User.save",
      callees: competingSaves(),
      candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
    },
    {
      cause: "two Symbols of that name in other components",
      target: "User.save",
      callees: [
        makeSymbol("ts:src/z.ts#User.save", { kind: "method", component: "reporting" }),
        makeSymbol("ts:src/b.ts#User.save", { kind: "method", component: "analytics" }),
      ],
      candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
    },
  ])("`ambiguous`, never a silent pick, for $cause, with the candidates lex-sorted", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: c.target,
        line: 4,
        bucket: "ambiguous",
        candidates: c.candidates,
      },
    ])
  })

  it("`dynamic` for an empty target", () => {
    expect(resolveOneCall("").diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  it("`dynamic` for an expression receiver, with nothing else about the call changed", () => {
    const plain = resolveOneCall("factory.save")
    const flagged = resolveOneCall("factory.save", { dynamicReceiver: true })
    expect(flagged.symbols).toEqual(plain.symbols)
    expect(flagged.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(flagged.edges).toEqual([])
    expect(flagged.stats.resolvedCalls).toBe(plain.stats.resolvedCalls)
    expect(plain.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
    expect(flagged.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: "factory.save",
        line: 4,
        bucket: "dynamic",
        candidates: [],
      },
    ])
  })

  it("leaves a call that resolves alone when its receiver is flagged as an expression", () => {
    const callees = [
      makeSymbol("ts:src/a.ts#helper", { kind: "class" }),
      makeSymbol("ts:src/a.ts#helper.save", { kind: "method" }),
    ]
    const plain = resolveOneCall("helper.save", { callees })
    const flagged = resolveOneCall("helper.save", { callees, dynamicReceiver: true })
    expect(flagged.edges).toEqual(plain.edges)
    expect(flagged.symbols).toEqual(plain.symbols)
    expect(flagged.diagnostics).toEqual([])
  })

  it.each<UnresolvedCase & { bucket: string; candidates: string[] }>([
    {
      cause: "`local-scope` over `external`, for a parameter named like an import",
      target: "sortBy",
      signature: params("sortBy"),
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"] }),
      bucket: "local-scope",
      candidates: [],
    },
    {
      cause: "`local-scope` over `dynamic`, for a parameter used as an expression receiver",
      target: "factory.save",
      signature: params("factory"),
      dynamicReceiver: true,
      bucket: "local-scope",
      candidates: [],
    },
    {
      cause: "`dynamic` over `ambiguous`, since an expression receiver was never resolvable",
      target: "User.save",
      callees: competingSaves(),
      dynamicReceiver: true,
      bucket: "dynamic",
      candidates: [],
    },
    {
      cause: "`dynamic` over `external`, for an expression receiver named like an import",
      target: "repo.save",
      imports: importsOf("src/a.ts", { source: "@acme/db", symbols: ["repo"] }),
      dynamicReceiver: true,
      bucket: "dynamic",
      candidates: [],
    },
    {
      cause:
        "`ambiguous` over `external`, since a recorded conflict outranks an out-of-reach import",
      target: "User.save",
      callees: competingSaves(),
      imports: importsOf("src/a.ts", { source: "@acme/models", symbols: ["User"] }),
      bucket: "ambiguous",
      candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
    },
  ])("prefers $cause", (c) => {
    expect(resolveOneCall(c.target, c).diagnostics.map((d) => [d.bucket, d.candidates])).toEqual([
      [c.bucket, c.candidates],
    ])
  })

  it("counts every call site in stats, and each unresolved one in its bucket", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: params("shadowed"),
      calls: [
        { target: "helper", line: 1, resolved: null },
        { target: "shadowed", line: 2, resolved: null },
        { target: "this.save", line: 3, resolved: null },
        { target: "typoed", line: 4, resolved: null },
      ],
    })
    const helper = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, helper], importsByFile: NO_IMPORTS })
    expect(result.stats).toEqual({
      totalCalls: 4,
      resolvedCalls: 1,
      unresolved: { localScope: 1, external: 0, dynamic: 1, ambiguous: 0, noMatch: 1 },
    })
  })

  it("counts the calls of a dropped Symbol too", () => {
    const dropped = withCalls("ts:src/a.ts#gone", [{ target: "typoed", line: 1 }], {
      dropped: true,
      dropReason: "cat-b:trivial",
    })
    const result = resolveCallGraph({ symbols: [dropped], importsByFile: NO_IMPORTS })
    expect(result.stats.totalCalls).toBe(1)
    expect(result.stats.unresolved.noMatch).toBe(1)
  })

  it("sorts diagnostics by (symbolId, line, target) whatever order the Symbols arrive in", () => {
    const late = withCalls("ts:src/z.ts#zeta", [{ target: "nope", line: 1 }])
    const early = withCalls("ts:src/a.ts#alpha", [
      { target: "b-nope", line: 9 },
      { target: "a-nope", line: 2 },
    ])
    const forward = resolveCallGraph({ symbols: [late, early], importsByFile: NO_IMPORTS })
    const reversed = resolveCallGraph({ symbols: [early, late], importsByFile: NO_IMPORTS })
    expect(forward.diagnostics.map((d) => `${d.symbolId}:${d.line}:${d.target}`)).toEqual([
      "ts:src/a.ts#alpha:2:a-nope",
      "ts:src/a.ts#alpha:9:b-nope",
      "ts:src/z.ts#zeta:1:nope",
    ])
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })
})
