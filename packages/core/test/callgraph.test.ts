import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../src/callgraph"
import { makeSymbol } from "./fixtures/ir"

function withCalls(
  id: string,
  calls: Array<{ target: string; line: number }>,
  overrides: Partial<IRSymbol> = {},
): IRSymbol {
  return makeSymbol(id, {
    calls: calls.map((c) => ({ target: c.target, line: c.line, resolved: null })),
    ...overrides,
  })
}

function importEdge(over: Partial<ImportEdge>): ImportEdge {
  return { source: ".", symbols: [], line: 1, dynamic: false, ...over }
}

describe("resolveCallGraph", () => {
  it("returns empty edges when no symbols exist", () => {
    const result = resolveCallGraph({ symbols: [], importsByFile: new Map() })
    expect(result.symbols).toEqual([])
    expect(result.edges).toEqual([])
  })

  it("emits no edges when calls[] is empty", () => {
    const caller = makeSymbol("ts:src/a.ts#caller")
    const result = resolveCallGraph({ symbols: [caller], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls).toEqual([])
  })

  it("file scope: resolves a top-level Symbol in the same file (confidence high)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 5 }])
    const callee = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        confidence: "high",
        line: 5,
      },
    ])
    expect(result.symbols[0]?.calls[0]?.resolved).toBe("ts:src/a.ts#helper")
  })

  it("file scope: dotted target resolves Cls.method when that Symbol exists", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.method", line: 7 }])
    const cls = makeSymbol("ts:src/a.ts#Cls", { kind: "class" })
    const method = makeSymbol("ts:src/a.ts#Cls.method", { kind: "method" })
    const result = resolveCallGraph({
      symbols: [caller, cls, method],
      importsByFile: new Map(),
    })
    expect(result.edges[0]?.to).toBe("ts:src/a.ts#Cls.method")
  })

  it("file scope: dotted target with missing method Symbol stays unresolved", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.absent", line: 9 }])
    const cls = makeSymbol("ts:src/a.ts#Cls", { kind: "class" })
    const result = resolveCallGraph({ symbols: [caller, cls], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("file scope: never crosses file boundaries", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 3 }])
    const callee = makeSymbol("ts:src/b.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  it("file scope: ambiguous top-level name in the same file stays unresolved", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 3 }])
    const a = makeSymbol("ts:src/a.ts#helper")
    const b = makeSymbol("ts:src/a.ts#helper.overload", { name: "helper" })
    const result = resolveCallGraph({ symbols: [caller, a, b], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  it("import scope: named import resolves through a relative specifier", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/util.ts#helper")
    expect(result.edges[0]?.confidence).toBe("high")
  })

  it("import scope: aliased named import maps local name to the exported qname", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "h", line: 4 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper as h"] })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/util.ts#helper")
  })

  it("import scope: namespace import resolves ns.member when basename matches the binding", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "util.helper", line: 8 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: "*" })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/util.ts#helper")
  })

  it("import scope: external bare specifier is not resolved", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "sortBy", line: 4 }])
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "lodash", symbols: ["sortBy"] })]],
    ])
    const result = resolveCallGraph({ symbols: [caller], importsByFile: imports })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("import scope: dynamic import is ignored", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"], dynamic: true })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges).toEqual([])
  })

  it("import scope: probes directory index.<ext> after direct extensions", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const callee = makeSymbol("ts:src/util/index.ts#helper", {
      source: {
        file: "src/util/index.ts",
        startLine: 1,
        endLine: 1,
        startColumn: null,
        endColumn: null,
      },
    })
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/util/index.ts#helper")
  })

  it("file scope wins over import scope when both bindings exist", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const inFile = makeSymbol("ts:src/a.ts#helper")
    const inImport = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const result = resolveCallGraph({
      symbols: [caller, inFile, inImport],
      importsByFile: imports,
    })
    expect(result.edges[0]?.to).toBe("ts:src/a.ts#helper")
  })

  it("preserves pre-existing non-null resolved values without overwriting them", () => {
    const caller: IRSymbol = makeSymbol("ts:src/a.ts#caller", {
      calls: [{ target: "helper", line: 4, resolved: "ts:src/x.ts#weird" }],
    })
    const inFile = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, inFile], importsByFile: new Map() })
    // resolver leaves the pre-existing resolution alone (LSP tier behaviour §5.4)
    expect(result.symbols[0]?.calls[0]?.resolved).toBe("ts:src/x.ts#weird")
    expect(result.edges).toEqual([])
  })

  it("skips dropped Symbols as call targets and does not fabricate edges into them", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 4 }])
    const dropped = makeSymbol("ts:src/a.ts#helper", {
      dropped: true,
      dropReason: "test",
    })
    const result = resolveCallGraph({ symbols: [caller, dropped], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  it("emits one edge per call site when the same callee is invoked on multiple lines", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "helper", line: 3 },
      { target: "helper", line: 7 },
    ])
    const callee = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges.map((e) => e.line)).toEqual([3, 7])
  })

  it("sorts edges deterministically by (from, to, line)", () => {
    const helper = makeSymbol("ts:src/util.ts#helper")
    const other = makeSymbol("ts:src/util.ts#other")
    const first = withCalls("ts:src/z.ts#z", [
      { target: "other", line: 8 },
      { target: "helper", line: 3 },
    ])
    const second = withCalls("ts:src/a.ts#a", [{ target: "helper", line: 12 }])
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/z.ts", [importEdge({ source: "./util", symbols: ["helper", "other"] })]],
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const result = resolveCallGraph({
      symbols: [first, second, helper, other],
      importsByFile: imports,
    })
    expect(result.edges.map((e) => `${e.from}->${e.to}@${e.line}`)).toEqual([
      "ts:src/a.ts#a->ts:src/util.ts#helper@12",
      "ts:src/z.ts#z->ts:src/util.ts#helper@3",
      "ts:src/z.ts#z->ts:src/util.ts#other@8",
    ])
  })
})
