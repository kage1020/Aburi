import { symbolId } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { CoreError } from "../src/errors"
import type { ReceiverHint } from "../src/lsp"
import { withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

describe("receiver hints from the LSP tier", () => {
  it.each<[string, IRSymbol]>([
    ["this.method", makeSymbol("ts:src/other.ts#this.method", { kind: "method" })],
    ["super.method", makeSymbol("ts:src/other.ts#super.method", { kind: "method" })],
    ["this.#v", makeSymbol("ts:src/a.ts#C.#v", { kind: "method" })],
  ])("`%s` stays unresolved without one, bucketed `dynamic`, whatever Symbol it might name", (target, lookalike) => {
    const caller = withCalls("ts:src/a.ts#C.bar", [{ target, line: 5 }])
    const result = resolveCallGraph({
      symbols: [caller, lookalike],
      importsByFile: NO_IMPORTS,
      receiverHints: new Map(),
    })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  it("a hint resolves the call it was produced for at high confidence, and none of its line-mates", () => {
    const caller = withCalls("ts:src/a.ts#Svc.run", [
      { target: "this.charge", line: 4 },
      { target: "sendPaymentToBank", line: 4 },
    ])
    const charge = makeSymbol("ts:src/a.ts#Svc.charge", { kind: "method" })
    const result = resolveCallGraph({
      symbols: [caller, charge],
      importsByFile: NO_IMPORTS,
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.charge"),
          { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Svc.charge") },
        ],
      ]),
    })
    expect(result.symbols[0]?.calls.map((call) => [call.target, call.resolved])).toEqual([
      ["this.charge", "ts:src/a.ts#Svc.charge"],
      ["sendPaymentToBank", null],
    ])
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      ["ts:src/a.ts#Svc.charge", "high"],
    ])
    expect(result.diagnostics.map((d) => d.target)).toEqual(["sendPaymentToBank"])
    expect(result.stats.resolvedCalls).toBe(1)
    expect(result.lspHintUsage).toEqual({ consumed: 1, kindMismatch: 0, targetDropped: 0 })
  })

  it.each<{
    refusal: string
    target: string
    hint: ReceiverHint
    targetDropped: boolean
    counted: "kindMismatch" | "targetDropped"
    bucket: string
  }>([
    {
      refusal: "a `this` hint aimed at a call with no receiver",
      target: "sendPaymentToBank",
      hint: { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Svc.charge") },
      targetDropped: false,
      counted: "kindMismatch",
      bucket: "no-match",
    },
    {
      refusal: "a `super` hint aimed at a `this` call",
      target: "this.charge",
      hint: { kind: "super", targetSymbolId: symbolId("ts:src/a.ts#Svc.charge") },
      targetDropped: false,
      counted: "kindMismatch",
      bucket: "dynamic",
    },
    {
      refusal: "a hint naming a dropped Symbol",
      target: "this.charge",
      hint: { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Svc.charge") },
      targetDropped: true,
      counted: "targetDropped",
      bucket: "dynamic",
    },
    {
      refusal: "a hint failing both checks, which counts as a kind mismatch alone",
      target: "this.charge",
      hint: { kind: "super", targetSymbolId: symbolId("ts:src/a.ts#Svc.charge") },
      targetDropped: true,
      counted: "kindMismatch",
      bucket: "dynamic",
    },
  ])("a refused hint leaves the call unresolved: $refusal", ({
    target,
    hint,
    targetDropped,
    counted,
    bucket,
  }) => {
    const caller = withCalls("ts:src/a.ts#Svc.run", [{ target, line: 4 }])
    const charge = makeSymbol("ts:src/a.ts#Svc.charge", {
      kind: "method",
      ...(targetDropped ? { dropped: true, dropReason: "cat-b:trivial" } : {}),
    })
    const result = resolveCallGraph({
      symbols: [caller, charge],
      importsByFile: NO_IMPORTS,
      receiverHints: new Map([[makeCallSiteKey("src/a.ts", 4, target), hint]]),
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual([bucket])
    expect(result.lspHintUsage).toEqual({
      consumed: 0,
      kindMismatch: 0,
      targetDropped: 0,
      [counted]: 1,
    })
  })

  it("a key not built by makeCallSiteKey raises rather than missing every lookup", () => {
    const caller = withCalls("ts:src/a.ts#Svc.run", [{ target: "this.helper", line: 6 }])
    const helper = makeSymbol("ts:src/a.ts#Svc.helper", { kind: "method" })
    const resolve = () =>
      resolveCallGraph({
        symbols: [caller, helper],
        importsByFile: NO_IMPORTS,
        receiverHints: new Map([
          ["src/a.ts:6", { kind: "this", targetSymbolId: symbolId("ts:src/a.ts#Svc.helper") }],
        ]),
      })
    expect(resolve).toThrow(CoreError)
    expect(resolve).toThrow(/makeCallSiteKey/)
    expect(resolve).toThrow(
      expect.objectContaining({ code: "receiver-hint-key-malformed", value: "src/a.ts:6" }),
    )
  })
})
