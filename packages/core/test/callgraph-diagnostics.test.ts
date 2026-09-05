import type { ImportEdge, Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { makeSymbol, type SymbolOverrides, symbolId } from "./fixtures/ir"

// call-resolution.md §8.1 — every `resolved: null` is a first-class outcome and the
// resolver reports WHY it declined. §10.4's CR27 / CR28 / CR29 are covered here.

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

function sig(...names: string[]): Signature {
  return {
    inputs: names.map((name) => ({ name, type: "unknown" })),
    outputs: ["void"],
    throws: [],
    async: false,
    generator: false,
    typeParameters: [],
  }
}

describe("resolveCallGraph — unresolved-call diagnostics (§8.1)", () => {
  it("CR27: an expression receiver is bucketed `dynamic`", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "factory.save", line: 9 }])
    const result = resolveCallGraph({
      symbols: [caller],
      importsByFile: new Map(),
      dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 9, "factory.save")]),
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: "factory.save",
        line: 9,
        bucket: "dynamic",
        candidates: [],
      },
    ])
  })

  it("CR28: a callee that exists nowhere is bucketed `no-match`", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "typoed", line: 3 }])
    const result = resolveCallGraph({ symbols: [caller], importsByFile: new Map() })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it("CR29: competing candidates are bucketed `ambiguous` and recorded lex-sorted", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "User.save", line: 4 }], {
      component: "billing",
    })
    const second = makeSymbol("ts:src/z.ts#User.save", {
      name: "User.save",
      kind: "method",
      component: "billing",
    })
    const first = makeSymbol("ts:src/b.ts#User.save", {
      name: "User.save",
      kind: "method",
      component: "billing",
    })
    const result = resolveCallGraph({
      symbols: [caller, second, first],
      importsByFile: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: "User.save",
        line: 4,
        bucket: "ambiguous",
        candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
      },
    ])
  })

  it("a callee shadowed by a caller parameter is bucketed `local-scope`", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: sig("helper"),
      calls: [{ target: "helper", line: 5, resolved: null }],
    })
    const helper = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, helper], importsByFile: new Map() })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["local-scope"])
  })

  it("a named import from a bare specifier is bucketed `external`", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "sortBy", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller],
      importsByFile: new Map([
        ["src/a.ts", [importEdge({ source: "lodash", symbols: ["sortBy"] })]],
      ]),
    })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it("a namespace import from a bare specifier is bucketed `external`", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "lodash.sortBy", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller],
      importsByFile: new Map([
        ["src/a.ts", [importEdge({ source: "lodash", symbols: "*", namespaceBinding: "lodash" })]],
      ]),
    })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it("an aliased import keeps the local binding as the `external` head", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "sort", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller],
      importsByFile: new Map([
        ["src/a.ts", [importEdge({ source: "lodash", symbols: ["sortBy as sort"] })]],
      ]),
    })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it("`this` / `super` with no LSP hint are bucketed `dynamic` (§4.7)", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "this.save", line: 2 },
      { target: "super.save", line: 3 },
    ])
    const result = resolveCallGraph({ symbols: [caller], importsByFile: new Map() })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic", "dynamic"])
  })

  it("a relative import that misses is bucketed `no-match`, not `external`", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller],
      importsByFile: new Map([["src/a.ts", [importEdge({ source: "./b", symbols: ["helper"] })]]]),
    })
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it("stats count every call site and the buckets close the arithmetic", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: sig("shadowed"),
      calls: [
        { target: "helper", line: 1, resolved: null },
        { target: "shadowed", line: 2, resolved: null },
        { target: "this.save", line: 3, resolved: null },
        { target: "typoed", line: 4, resolved: null },
      ],
    })
    const helper = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({ symbols: [caller, helper], importsByFile: new Map() })
    expect(result.stats).toEqual({
      totalCalls: 4,
      resolvedCalls: 1,
      unresolved: { localScope: 1, external: 0, dynamic: 1, ambiguous: 0, noMatch: 1 },
    })
    const { unresolved } = result.stats
    const summed =
      unresolved.localScope +
      unresolved.external +
      unresolved.dynamic +
      unresolved.ambiguous +
      unresolved.noMatch
    expect(result.stats.totalCalls - result.stats.resolvedCalls).toBe(summed)
  })

  it("reports zeroes rather than being absent when there is nothing to resolve", () => {
    const result = resolveCallGraph({ symbols: [], importsByFile: new Map() })
    expect(result.stats).toEqual({
      totalCalls: 0,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
    })
    expect(result.diagnostics).toEqual([])
  })

  it("diagnostics sort by (symbolId, line, target) regardless of input order", () => {
    const late = withCalls("ts:src/z.ts#zeta", [{ target: "nope", line: 1 }])
    const early = withCalls("ts:src/a.ts#alpha", [
      { target: "b-nope", line: 9 },
      { target: "a-nope", line: 2 },
    ])
    const forward = resolveCallGraph({ symbols: [late, early], importsByFile: new Map() })
    const reversed = resolveCallGraph({ symbols: [early, late], importsByFile: new Map() })
    expect(forward.diagnostics.map((d) => `${d.symbolId}:${d.line}:${d.target}`)).toEqual([
      "ts:src/a.ts#alpha:2:a-nope",
      "ts:src/a.ts#alpha:9:b-nope",
      "ts:src/z.ts#zeta:1:nope",
    ])
    expect(JSON.stringify(reversed.diagnostics)).toBe(JSON.stringify(forward.diagnostics))
  })

  it("is byte-stable across repeated runs on the same input", () => {
    const caller = withCalls("ts:src/a.ts#caller", [
      { target: "typoed", line: 1 },
      { target: "this.save", line: 2 },
    ])
    const symbols = [caller]
    const first = resolveCallGraph({ symbols, importsByFile: new Map() })
    const second = resolveCallGraph({ symbols, importsByFile: new Map() })
    expect(JSON.stringify(first.diagnostics)).toBe(JSON.stringify(second.diagnostics))
    expect(JSON.stringify(first.stats)).toBe(JSON.stringify(second.stats))
  })

  it("`dynamicCallSites` changes only the bucket — never `resolved`, never the edges", () => {
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "helper.save", line: 4 }])
    const cls = makeSymbol("ts:src/a.ts#helper", { kind: "class" })
    const method = makeSymbol("ts:src/a.ts#helper.save", { kind: "method" })
    const symbols = [caller, cls, method]
    const plain = resolveCallGraph({ symbols, importsByFile: new Map() })
    const flagged = resolveCallGraph({
      symbols,
      importsByFile: new Map(),
      dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 4, "helper.save")]),
    })
    expect(JSON.stringify(flagged.edges)).toBe(JSON.stringify(plain.edges))
    expect(JSON.stringify(flagged.symbols)).toBe(JSON.stringify(plain.symbols))
    // The call resolved, so no diagnostic is emitted on either side.
    expect(flagged.diagnostics).toEqual([])
    expect(plain.diagnostics).toEqual([])
  })

  it("`dynamicCallSites` on an UNRESOLVED call moves only the bucket", () => {
    // The resolved-call guard above proves the flag cannot manufacture an edge.
    // This one proves the converse: on a call that stays null either way, the
    // flag must not change `resolved`, the edges, or anything but the bucket.
    const caller = withCalls("ts:src/a.ts#caller", [{ target: "factory.save", line: 4 }])
    const symbols = [caller]
    const plain = resolveCallGraph({ symbols, importsByFile: new Map() })
    const flagged = resolveCallGraph({
      symbols,
      importsByFile: new Map(),
      dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 4, "factory.save")]),
    })

    expect(plain.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(flagged.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(plain.edges).toEqual([])
    expect(flagged.edges).toEqual([])
    expect(JSON.stringify(flagged.symbols)).toBe(JSON.stringify(plain.symbols))

    expect(plain.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
    expect(flagged.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
    expect(flagged.stats.totalCalls).toBe(plain.stats.totalCalls)
    expect(flagged.stats.resolvedCalls).toBe(plain.stats.resolvedCalls)
  })

  it("an LSP hint pointing at a dropped Symbol keeps the call in `dynamic`", () => {
    // Receiver hints are only ever built for `this.` / `super.` call sites, so
    // when the hinted target turns out to be dropped the §4.7 guard has already
    // marked the receiver unnamed and `dynamic` is the honest bucket. Pinning it
    // here so the fallback can never quietly become `no-match`, which would send
    // a reviewer hunting for a typo that does not exist.
    const caller = withCalls("ts:src/a.ts#Svc.run", [{ target: "this.helper", line: 6 }])
    const droppedTarget = makeSymbol("ts:src/a.ts#Svc.helper", {
      kind: "method",
      dropped: true,
      dropReason: "cat-b:trivial",
    })
    const result = resolveCallGraph({
      symbols: [caller, droppedTarget],
      importsByFile: new Map(),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 6, "this.helper"),
          { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Svc.helper") },
        ],
      ]),
    })
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  // §8.1 fixes the tie-break order — `local-scope` → `dynamic` → `ambiguous` →
  // `external` → `no-match` — because a call can honestly answer to several
  // descriptions at once and the reviewer needs one stable verdict. Each case
  // below constructs a genuine two-way tie; without them a reordering of
  // `classifyUnresolved` would move counts between buckets on unchanged code
  // and every single-cause test above would still pass.
  describe("bucket precedence tie-breaks", () => {
    it("`local-scope` beats `external` when a parameter shadows an imported name", () => {
      const caller = makeSymbol("ts:src/a.ts#caller", {
        signature: sig("sortBy"),
        calls: [{ target: "sortBy", line: 2, resolved: null }],
      })
      const result = resolveCallGraph({
        symbols: [caller],
        importsByFile: new Map([
          ["src/a.ts", [importEdge({ source: "lodash", symbols: ["sortBy"] })]],
        ]),
      })
      expect(result.diagnostics.map((d) => d.bucket)).toEqual(["local-scope"])
    })

    it("`local-scope` beats `dynamic` when a parameter shadows an expression receiver", () => {
      const caller = makeSymbol("ts:src/a.ts#caller", {
        signature: sig("factory"),
        calls: [{ target: "factory.save", line: 3, resolved: null }],
      })
      const result = resolveCallGraph({
        symbols: [caller],
        importsByFile: new Map(),
        dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 3, "factory.save")]),
      })
      expect(result.diagnostics.map((d) => d.bucket)).toEqual(["local-scope"])
    })

    it("`dynamic` beats `ambiguous` — an expression receiver was never resolvable", () => {
      const caller = withCalls("ts:src/a.ts#caller", [{ target: "User.save", line: 4 }], {
        component: "billing",
      })
      const first = makeSymbol("ts:src/b.ts#User.save", {
        name: "User.save",
        kind: "method",
        component: "billing",
      })
      const second = makeSymbol("ts:src/z.ts#User.save", {
        name: "User.save",
        kind: "method",
        component: "billing",
      })
      const result = resolveCallGraph({
        symbols: [caller, first, second],
        importsByFile: new Map(),
        dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 4, "User.save")]),
      })
      expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
      expect(result.diagnostics[0]?.candidates).toEqual([])
    })

    it("`dynamic` beats `external` when the head is also a bare-specifier import", () => {
      const caller = withCalls("ts:src/a.ts#caller", [{ target: "repo.save", line: 5 }])
      const result = resolveCallGraph({
        symbols: [caller],
        importsByFile: new Map([
          ["src/a.ts", [importEdge({ source: "@acme/db", symbols: ["repo"] })]],
        ]),
        dynamicCallSites: new Set([makeCallSiteKey("src/a.ts", 5, "repo.save")]),
      })
      expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
    })

    it("`ambiguous` beats `external` — a recorded conflict outranks an out-of-reach import", () => {
      const caller = withCalls("ts:src/a.ts#caller", [{ target: "User.save", line: 6 }], {
        component: "billing",
      })
      const first = makeSymbol("ts:src/b.ts#User.save", {
        name: "User.save",
        kind: "method",
        component: "billing",
      })
      const second = makeSymbol("ts:src/z.ts#User.save", {
        name: "User.save",
        kind: "method",
        component: "billing",
      })
      const result = resolveCallGraph({
        symbols: [caller, first, second],
        importsByFile: new Map([
          ["src/a.ts", [importEdge({ source: "@acme/models", symbols: ["User"] })]],
        ]),
      })
      expect(result.diagnostics.map((d) => d.bucket)).toEqual(["ambiguous"])
      expect(result.diagnostics[0]?.candidates).toEqual([
        "ts:src/b.ts#User.save",
        "ts:src/z.ts#User.save",
      ])
    })
  })

  it("counts by calls[], not by the `dropped` flag", () => {
    // The extraction pipeline gives dropped Symbols an empty `calls[]`, so in
    // practice they contribute nothing. This fixture violates that on purpose to
    // pin down which rule the counters actually follow: a call site is counted
    // because it is in `calls[]`, full stop. If the counters ever started
    // skipping dropped Symbols, `totalCalls` would silently disagree with
    // integrity invariant #15, which counts the same way.
    const dropped = withCalls("ts:src/a.ts#gone", [{ target: "typoed", line: 1 }], {
      dropped: true,
      dropReason: "cat-b:trivial",
    })
    const result = resolveCallGraph({ symbols: [dropped], importsByFile: new Map() })
    expect(result.stats.totalCalls).toBe(1)
    expect(result.stats.unresolved.noMatch).toBe(1)
  })
})
