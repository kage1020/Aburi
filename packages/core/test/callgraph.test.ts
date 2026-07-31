import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { reconstructCallEdgesFromIR, resolveCallGraph } from "../src/callgraph"
import { makeSymbol, minimalIR, type SymbolOverrides } from "./fixtures/ir"

function withCalls(
  id: string,
  calls: Array<{ target: string; line: number }>,
  overrides: SymbolOverrides = {},
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

  it("file scope: a dotted target that cannot form a Symbol id stays unresolved, not fatal", () => {
    // The candidate id here is built from a qname the id grammar rejects. Resolution asks
    // "does this callee exist?", and the answer for an unbuildable id is no — the same
    // answer a well-formed id absent from the Symbol set would get. Aborting the scan
    // instead would make one odd call expression fail the whole run.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.not an identifier", line: 3 }])
    const cls = makeSymbol("ts:src/a.ts#Cls", { kind: "class" })
    const result = resolveCallGraph({ symbols: [caller, cls], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
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

  it("import scope: namespace import resolves ns.member via the explicit namespaceBinding", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "util.helper", line: 8 }])
    const callee = makeSymbol("ts:src/util.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: "*", namespaceBinding: "util" })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/util.ts#helper")
  })

  it("import scope: namespace binding uses the local alias even when the specifier basename differs", () => {
    // `import * as helpers from './my-utilities'` — the module basename is
    // `my-utilities` (not a legal identifier) but the caller writes
    // `helpers.helper()`. The resolver must key off the explicit binding, not
    // the specifier basename.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helpers.helper", line: 8 }])
    const callee = makeSymbol("ts:src/my-utilities.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      [
        "src/a.ts",
        [importEdge({ source: "./my-utilities", symbols: "*", namespaceBinding: "helpers" })],
      ],
    ])
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: imports })
    expect(result.edges[0]?.to).toBe("ts:src/my-utilities.ts#helper")
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

  it("local shadow (§4.2): a caller parameter named `helper` prevents an edge to the file-scope `helper` Symbol", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: {
        inputs: [{ name: "helper", type: "() => void" }],
        outputs: ["void"],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
      calls: [{ target: "helper", line: 5, resolved: null }],
    })
    const helper = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, helper], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("local shadow also blocks dotted targets whose head is a parameter (`helper.method`)", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: {
        inputs: [{ name: "helper", type: "{ method(): void }" }],
        outputs: ["void"],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
      calls: [{ target: "helper.method", line: 5, resolved: null }],
    })
    const shadowed = makeSymbol("ts:src/a.ts#helper", { kind: "class" })
    const method = makeSymbol("ts:src/a.ts#helper.method", { kind: "method" })
    const result = resolveCallGraph({
      symbols: [caller, shadowed, method],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
  })

  it("never fabricates an edge into a dropped Symbol body (file scope, direct name)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 5 }])
    const dropped = makeSymbol("ts:src/a.ts#helper", {
      dropped: true,
      dropReason: "test",
    })
    const result = resolveCallGraph({ symbols: [caller, dropped], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("never fabricates an edge into a dropped Symbol body (file scope, composite Cls.method)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.method", line: 5 }])
    const cls = makeSymbol("ts:src/a.ts#Cls", { kind: "class" })
    const droppedMethod = makeSymbol("ts:src/a.ts#Cls.method", {
      kind: "method",
      dropped: true,
      dropReason: "test",
    })
    const result = resolveCallGraph({
      symbols: [caller, cls, droppedMethod],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
  })

  it("never fabricates an edge into a dropped Symbol body (import scope)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 5 }])
    const droppedImported = makeSymbol("ts:src/util.ts#helper", {
      dropped: true,
      dropReason: "test",
    })
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./util", symbols: ["helper"] })]],
    ])
    const result = resolveCallGraph({
      symbols: [caller, droppedImported],
      importsByFile: imports,
    })
    expect(result.edges).toEqual([])
  })

  it("import scope ambiguity (§7.1): two imports binding the same head are left null, not silently picked", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 5 }])
    const first = makeSymbol("ts:src/one.ts#helper")
    const second = makeSymbol("ts:src/two.ts#helper")
    const imports = new Map<string, readonly ImportEdge[]>([
      [
        "src/a.ts",
        [
          importEdge({ source: "./one", symbols: ["helper"] }),
          importEdge({ source: "./two", symbols: ["helper"] }),
        ],
      ],
    ])
    const result = resolveCallGraph({
      symbols: [caller, first, second],
      importsByFile: imports,
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("import scope: cross-file dotted target resolves the composite id when the class Symbol exists over there", () => {
    // `import { Cls } from './x'; new Cls().method()` — the head `Cls` binds
    // to `x.ts#Cls`, the tail `method` extends the composite qname, and the
    // resulting id `ts:src/x.ts#Cls.method` is looked up as a whole.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.method", line: 5 }])
    const cls = makeSymbol("ts:src/x.ts#Cls", { kind: "class" })
    const method = makeSymbol("ts:src/x.ts#Cls.method", { kind: "method" })
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./x", symbols: ["Cls"] })]],
    ])
    const result = resolveCallGraph({
      symbols: [caller, cls, method],
      importsByFile: imports,
    })
    expect(result.edges[0]?.to).toBe("ts:src/x.ts#Cls.method")
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

  // ---------------------------------------------------------------------------
  // §4.5 Component scope — CR11 / CR13, precedence, dropped, cross-language guard
  // ---------------------------------------------------------------------------

  it("component scope (CR11): qualified name unique within the caller's component resolves with medium confidence", () => {
    // No explicit import for `PricingService` — the resolver must fall through
    // §4.3 (file scope, no such Symbol) and §4.4 (no import), then find the
    // method Symbol by qname within the same component.
    const caller = withCalls(
      "ts:src/checkout.ts#caller",
      [{ target: "PricingService.calc", line: 5 }],
      { component: "billing" },
    )
    const callee = makeSymbol("ts:src/pricing.ts#PricingService.calc", {
      kind: "method",
      component: "billing",
    })
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges).toEqual([
      {
        from: "ts:src/checkout.ts#caller",
        to: "ts:src/pricing.ts#PricingService.calc",
        via: "call",
        confidence: "medium",
        line: 5,
      },
    ])
  })

  it("component scope: does not cross component boundaries", () => {
    // Two same-named candidates exist workspace-wide but neither shares the
    // caller's component. §4.5 must NOT pick either (its filter is strict); §4.6
    // must NOT pick either (workspace ambiguity). Result: no edge — proving
    // §4.5's component filter is real and not accidentally satisfied by §4.6.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "PricingService.calc", line: 5 }], {
      component: "billing",
    })
    const firstElsewhere = makeSymbol("ts:src/one.ts#PricingService.calc", {
      kind: "method",
      component: "reporting",
    })
    const secondElsewhere = makeSymbol("ts:src/two.ts#PricingService.calc", {
      kind: "method",
      component: "analytics",
    })
    const result = resolveCallGraph({
      symbols: [caller, firstElsewhere, secondElsewhere],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("component scope (CR13): ambiguous qualified name within a component stays unresolved", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "PricingService.calc", line: 5 }], {
      component: "billing",
    })
    const first = makeSymbol("ts:src/one.ts#PricingService.calc", {
      kind: "method",
      component: "billing",
    })
    const second = makeSymbol("ts:src/two.ts#PricingService.calc", {
      kind: "method",
      component: "billing",
    })
    const result = resolveCallGraph({
      symbols: [caller, first, second],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("component scope: single-identifier target is not searched (must be qualified)", () => {
    // `helper` alone must not be resolved through §4.5 even when a Symbol
    // named `helper` exists in the same component but a different file —
    // otherwise §4.3/§4.4's "same file / imported only" contract would leak.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 3 }], {
      component: "billing",
    })
    const callee = makeSymbol("ts:src/b.ts#helper", { component: "billing" })
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  it("component scope: dropped Symbol is skipped as callee candidate", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "PricingService.calc", line: 5 }], {
      component: "billing",
    })
    const dropped = makeSymbol("ts:src/pricing.ts#PricingService.calc", {
      kind: "method",
      component: "billing",
      dropped: true,
      dropReason: "test",
    })
    const result = resolveCallGraph({ symbols: [caller, dropped], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // §4.6 Workspace scope — CR12, ambiguity, cross-language guard, precedence
  // ---------------------------------------------------------------------------

  it("workspace scope (CR12): globally-unique qualified name resolves with low confidence", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Uniq.method", line: 9 }], {
      component: "billing",
    })
    const callee = makeSymbol("ts:src/other.ts#Uniq.method", {
      kind: "method",
      component: "reporting",
    })
    const result = resolveCallGraph({ symbols: [caller, callee], importsByFile: new Map() })
    expect(result.edges).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/other.ts#Uniq.method",
        via: "call",
        confidence: "low",
        line: 9,
      },
    ])
  })

  it("workspace scope: ambiguous globally leaves the call null (no silent pick)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Uniq.method", line: 9 }], {
      component: "billing",
    })
    const first = makeSymbol("ts:src/one.ts#Uniq.method", {
      kind: "method",
      component: "reporting",
    })
    const second = makeSymbol("ts:src/two.ts#Uniq.method", {
      kind: "method",
      component: "analytics",
    })
    const result = resolveCallGraph({
      symbols: [caller, first, second],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("§7.3 cross-language: workspace scope only matches within the caller's language", () => {
    // A Python Symbol with the same qname must not be selected by a TS caller.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Uniq.method", line: 4 }], {
      component: "billing",
    })
    const py = makeSymbol("py:src/other.py#Uniq.method", {
      kind: "method",
      language: "py",
      component: "reporting",
    })
    const result = resolveCallGraph({ symbols: [caller, py], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  it("component scope wins over workspace scope when both would match (§4.5 precedes §4.6)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Shared.method", line: 5 }], {
      component: "billing",
    })
    const inComponent = makeSymbol("ts:src/near.ts#Shared.method", {
      kind: "method",
      component: "billing",
    })
    const outOfComponent = makeSymbol("ts:src/far.ts#Shared.method", {
      kind: "method",
      component: "reporting",
    })
    const result = resolveCallGraph({
      symbols: [caller, inComponent, outOfComponent],
      importsByFile: new Map(),
    })
    // Component-scope match must win: medium, not low.
    expect(result.edges).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/near.ts#Shared.method",
        via: "call",
        confidence: "medium",
        line: 5,
      },
    ])
  })

  it("import scope wins over component/workspace scope (Step 3 precedes Step 4/5)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls.method", line: 4 }], {
      component: "billing",
    })
    const imported = makeSymbol("ts:src/x.ts#Cls.method", { kind: "method", component: "billing" })
    const clsForImport = makeSymbol("ts:src/x.ts#Cls", { kind: "class", component: "billing" })
    const componentOnly = makeSymbol("ts:src/y.ts#Cls.method", {
      kind: "method",
      component: "billing",
    })
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./x", symbols: ["Cls"] })]],
    ])
    const result = resolveCallGraph({
      symbols: [caller, imported, clsForImport, componentOnly],
      importsByFile: imports,
    })
    // Import wins: confidence must be high, targeting the imported file — not
    // medium via the component-scope candidate in y.ts.
    expect(result.edges).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/x.ts#Cls.method",
        via: "call",
        confidence: "high",
        line: 4,
      },
    ])
  })

  it("workspace scope: dropped Symbol is skipped as callee candidate", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Uniq.method", line: 4 }], {
      component: "billing",
    })
    const dropped = makeSymbol("ts:src/other.ts#Uniq.method", {
      kind: "method",
      component: "reporting",
      dropped: true,
      dropReason: "test",
    })
    const result = resolveCallGraph({ symbols: [caller, dropped], importsByFile: new Map() })
    expect(result.edges).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // §4.7 dynamic-dispatch / special targets — CR14, CR15
  // ---------------------------------------------------------------------------

  it("CR14: `this.method` in untyped tier stays unresolved even when a same-name Symbol exists", () => {
    // `this` is a runtime value; the untyped tier must not fabricate an edge
    // to `SomeClass.method` just because the qname `this.method` would
    // textually match a workspace Symbol.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "this.method", line: 5 }], {
      component: "billing",
    })
    const fake = makeSymbol("ts:src/other.ts#this.method", {
      kind: "method",
      component: "billing",
    })
    const result = resolveCallGraph({ symbols: [caller, fake], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("§4.7: `super.method` in untyped tier stays unresolved even when a same-name Symbol exists", () => {
    // Symmetric guard to CR14 — `super` resolves through the class hierarchy,
    // which only the LSP tier can see. Without a dedicated test the `super`
    // branch of the §4.7 guard could be dropped in a refactor without any
    // regression being caught.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "super.method", line: 5 }], {
      component: "billing",
    })
    const fake = makeSymbol("ts:src/other.ts#super.method", {
      kind: "method",
      component: "billing",
    })
    const result = resolveCallGraph({ symbols: [caller, fake], importsByFile: new Map() })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("§4.2 parameter shadow also blocks §4.5 / §4.6 for dotted targets", () => {
    // If §4.5 / §4.6 ran before the parameter guard — or if the guard only
    // covered §4.3 / §4.4 — a caller parameter named `helper` could still
    // resolve to a workspace Symbol `helper.method` through component or
    // workspace scope. The tier order must ensure parameters short-circuit
    // every subsequent scope, not just the file / import scopes.
    const caller = makeSymbol("ts:src/a.ts#caller", {
      component: "billing",
      signature: {
        inputs: [{ name: "helper", type: "{ method(): void }" }],
        outputs: ["void"],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
      calls: [{ target: "helper.method", line: 5, resolved: null }],
    })
    // Component-scope candidate (would resolve to medium without the guard).
    const inComponent = makeSymbol("ts:src/x.ts#helper.method", {
      kind: "method",
      component: "billing",
    })
    // Workspace-scope candidate (would resolve to low without the guard).
    const inWorkspace = makeSymbol("ts:src/y.ts#helper.method", {
      kind: "method",
      component: "reporting",
    })
    const result = resolveCallGraph({
      symbols: [caller, inComponent, inWorkspace],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("CR15: `new ClassName()` resolves the class Symbol via imports (confidence high)", () => {
    // `walkBody` normalizes `new Cls()` to the callee identifier `Cls`; that
    // reaches import scope and lands on the class Symbol with confidence high.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "Cls", line: 6 }])
    const cls = makeSymbol("ts:src/x.ts#Cls", { kind: "class" })
    const imports = new Map<string, readonly ImportEdge[]>([
      ["src/a.ts", [importEdge({ source: "./x", symbols: ["Cls"] })]],
    ])
    const result = resolveCallGraph({ symbols: [caller, cls], importsByFile: imports })
    expect(result.edges).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/x.ts#Cls",
        via: "call",
        confidence: "high",
        line: 6,
      },
    ])
  })

  // ---------------------------------------------------------------------------
  // Integrated matrix — intra-file / intra-component / workspace / dynamic in one run
  // ---------------------------------------------------------------------------

  describe("resolveCallGraph — integrated resolution matrix", () => {
    it("resolves intra-file / intra-package / cross-package / dynamic in one run", () => {
      // caller invokes four callees in one body — each one exercises a
      // distinct tier of the resolver:
      //   L10 same-file       → high  (file scope, §4.3)
      //   L20 same-component  → medium (component scope, §4.5)
      //   L30 workspace-only  → low    (workspace scope, §4.6)
      //   L40 dynamic (this.) → null   (§4.7 — no edge)
      const caller = makeSymbol("ts:src/a.ts#caller", {
        component: "billing",
        calls: [
          { target: "sameFile", line: 10, resolved: null },
          { target: "PkgSvc.calc", line: 20, resolved: null },
          { target: "GlobalUniq.method", line: 30, resolved: null },
          { target: "this.method", line: 40, resolved: null },
        ],
      })
      const sameFile = makeSymbol("ts:src/a.ts#sameFile", { component: "billing" })
      const pkgSvc = makeSymbol("ts:src/pricing.ts#PkgSvc.calc", {
        kind: "method",
        component: "billing",
      })
      const globalUniq = makeSymbol("ts:src/report.ts#GlobalUniq.method", {
        kind: "method",
        component: "reporting",
      })
      const result = resolveCallGraph({
        symbols: [caller, sameFile, pkgSvc, globalUniq],
        importsByFile: new Map(),
      })
      expect(result.edges).toEqual([
        {
          from: "ts:src/a.ts#caller",
          to: "ts:src/a.ts#sameFile",
          via: "call",
          confidence: "high",
          line: 10,
        },
        {
          from: "ts:src/a.ts#caller",
          to: "ts:src/pricing.ts#PkgSvc.calc",
          via: "call",
          confidence: "medium",
          line: 20,
        },
        {
          from: "ts:src/a.ts#caller",
          to: "ts:src/report.ts#GlobalUniq.method",
          via: "call",
          confidence: "low",
          line: 30,
        },
      ])
      const updated = result.symbols.find((s) => s.id === "ts:src/a.ts#caller")
      expect(updated?.calls.map((c) => c.resolved)).toEqual([
        "ts:src/a.ts#sameFile",
        "ts:src/pricing.ts#PkgSvc.calc",
        "ts:src/report.ts#GlobalUniq.method",
        null,
      ])
    })

    it("determinism (CR23): running the same input twice yields byte-identical edges", () => {
      const caller = withCalls(
        "ts:src/a.ts#caller",
        [
          { target: "PricingService.calc", line: 5 },
          { target: "GlobalUniq.method", line: 6 },
        ],
        { component: "billing" },
      )
      const inComponent = makeSymbol("ts:src/pricing.ts#PricingService.calc", {
        kind: "method",
        component: "billing",
      })
      const inWorkspace = makeSymbol("ts:src/report.ts#GlobalUniq.method", {
        kind: "method",
        component: "reporting",
      })
      const symbols = [caller, inComponent, inWorkspace]
      const first = resolveCallGraph({ symbols, importsByFile: new Map() })
      const second = resolveCallGraph({ symbols, importsByFile: new Map() })
      expect(JSON.stringify(first.edges)).toBe(JSON.stringify(second.edges))
      expect(JSON.stringify(first.symbols)).toBe(JSON.stringify(second.symbols))
    })
  })
})

describe("reconstructCallEdgesFromIR", () => {
  it("returns [] for an IR with no symbols", () => {
    expect(reconstructCallEdgesFromIR(minimalIR())).toEqual([])
  })

  it("returns [] for an IR whose symbols all have empty calls[]", () => {
    const ir = minimalIR()
    ir.symbols = [makeSymbol("ts:src/a.ts#a"), makeSymbol("ts:src/a.ts#b")]
    expect(reconstructCallEdgesFromIR(ir)).toEqual([])
  })

  it("skips calls with resolved: null (unresolved calls emit no edge)", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [{ target: "unknown", line: 3, resolved: null }],
      }),
    ]
    expect(reconstructCallEdgesFromIR(ir)).toEqual([])
  })

  it("emits one edge per resolved call with the CallEdge shape from call-resolution.md §7.1", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        confidence: "high",
        calls: [{ target: "helper", line: 5, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    expect(reconstructCallEdgesFromIR(ir)).toEqual([
      {
        from: "ts:src/a.ts#caller",
        to: "ts:src/a.ts#helper",
        via: "call",
        confidence: "high",
        line: 5,
      },
    ])
  })

  it("inherits confidence from the caller Symbol's own confidence field", () => {
    // ir-schema.md does not model per-call confidence; the reconstructed edge
    // uses the containing Symbol's confidence as a defensible floor.
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#weak", {
        confidence: "low",
        calls: [{ target: "helper", line: 1, resolved: "ts:src/a.ts#helper" }],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    expect(reconstructCallEdgesFromIR(ir)[0]?.confidence).toBe("low")
  })

  it("emits one edge per call site when the same caller invokes the same callee on multiple lines", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#caller", {
        calls: [
          { target: "helper", line: 3, resolved: "ts:src/a.ts#helper" },
          { target: "helper", line: 7, resolved: "ts:src/a.ts#helper" },
        ],
      }),
      makeSymbol("ts:src/a.ts#helper"),
    ]
    const edges = reconstructCallEdgesFromIR(ir)
    expect(edges).toHaveLength(2)
    expect(edges.map((e) => e.line)).toEqual([3, 7])
  })

  it("sorts edges by (from, to, line) ascending — matches resolveCallGraph's output order", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/z.ts#z", {
        calls: [{ target: "b", line: 4, resolved: "ts:src/b.ts#b" }],
      }),
      makeSymbol("ts:src/a.ts#a", {
        calls: [
          { target: "c", line: 2, resolved: "ts:src/c.ts#c" },
          { target: "b", line: 1, resolved: "ts:src/b.ts#b" },
        ],
      }),
      makeSymbol("ts:src/b.ts#b"),
      makeSymbol("ts:src/c.ts#c"),
    ]
    const edges = reconstructCallEdgesFromIR(ir)
    expect(edges.map((e) => `${e.from}->${e.to}@${e.line}`)).toEqual([
      "ts:src/a.ts#a->ts:src/b.ts#b@1",
      "ts:src/a.ts#a->ts:src/c.ts#c@2",
      "ts:src/z.ts#z->ts:src/b.ts#b@4",
    ])
  })

  it("is deterministic — repeated invocations return byte-identical output", () => {
    const ir = minimalIR()
    ir.symbols = [
      makeSymbol("ts:src/a.ts#a", {
        calls: [{ target: "b", line: 1, resolved: "ts:src/a.ts#b" }],
      }),
      makeSymbol("ts:src/a.ts#b"),
    ]
    const one = reconstructCallEdgesFromIR(ir)
    const two = reconstructCallEdgesFromIR(ir)
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
  })
})
