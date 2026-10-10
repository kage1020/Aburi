import { makeIR, symbolById } from "@aburi/test-support"
import type { Confidence, Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { propagateEffects } from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"
import { edge, localEffect } from "./fixtures/propagate"

function effectsOf(symbols: IRSymbol[], id: string): Effect[] {
  return symbolById({ ir: makeIR({ symbols }) }, id).effects
}

function propagatedOf(symbols: IRSymbol[], id: string): Effect[] {
  return effectsOf(symbols, id).filter((e) => e.propagated === true)
}

const A = "ts:a.ts#A"
const B = "ts:b.ts#B"
const C = "ts:c.ts#C"
const D = "ts:d.ts#D"

describe("what reaches a caller", () => {
  it("carries a callee's effect to its caller, without a line", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, { effects: [localEffect({ id: "db.write", target: "prisma.x", line: 8 })] }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, B)] })

    expect(propagatedOf(out, A)).toEqual([
      {
        id: "db.write",
        target: "prisma.x",
        plugin: "effects-test",
        confidence: "high",
        derivedBy: "convention:test",
        propagated: true,
        derivedFrom: [B],
      },
    ])
  })

  it("names the direct callee at every hop of a chain, never the far end", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C),
      makeSymbol(D, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [edge(A, B), edge(B, C), edge(C, D)]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.derivedFrom)).toEqual([[B]])
    expect(propagatedOf(out, B).map((e) => e.derivedFrom)).toEqual([[C]])
    expect(propagatedOf(out, C).map((e) => e.derivedFrom)).toEqual([[D]])
    expect(propagatedOf(out, D)).toEqual([])
  })

  it("merges a diamond into one entry deriving from both callees, sorted", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C),
      makeSymbol(D, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [edge(A, C), edge(A, B), edge(B, D), edge(C, D)]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.derivedFrom)).toEqual([[B, C]])
  })

  it("gives every member of a cycle the effect one member detects", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [edge(A, B), edge(B, C), edge(C, A)]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.derivedFrom)).toEqual([[B]])
    expect(propagatedOf(out, B).map((e) => e.derivedFrom)).toEqual([[C]])
    expect(effectsOf(out, C)).toEqual(symbols[2]?.effects)
  })

  it("adds nothing for a self-loop on a symbol that detects the effect itself", () => {
    const symbols = [makeSymbol(A, { effects: [localEffect({ id: "db.write", target: "x" })] })]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, A)] })

    expect(effectsOf(out, A)).toEqual(symbols[0]?.effects)
  })

  it("lets a local effect shadow the same (id, target) arriving from a callee", () => {
    const local = localEffect({ id: "db.write", target: "x", line: 42, confidence: "medium" })
    const symbols = [
      makeSymbol(A, { effects: [local] }),
      makeSymbol(B, {
        effects: [localEffect({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, B)] })

    expect(effectsOf(out, A)).toEqual([local])
  })

  it("propagates through a boundary decorator", () => {
    const symbols = [
      makeSymbol("ts:ctl.ts#Ctl", {
        decorators: [{ name: "Post", raw: "Post()", arguments: [], boundary: true, line: 1 }],
      }),
      makeSymbol("ts:svc.ts#Svc"),
      makeSymbol("ts:repo.ts#Repo", { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [edge("ts:ctl.ts#Ctl", "ts:svc.ts#Svc"), edge("ts:svc.ts#Svc", "ts:repo.ts#Repo")]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, "ts:ctl.ts#Ctl").map((e) => e.id)).toEqual(["db.write"])
  })

  it("propagates nothing without an edge, and hands every symbol back once", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [] })

    expect(out).toEqual(symbols)
  })
})

describe("the confidence a propagated effect carries", () => {
  it.each<[Confidence, Confidence, Confidence]>([
    ["high", "medium", "medium"],
    ["medium", "high", "medium"],
    ["low", "high", "low"],
  ])("is the weaker of edge %s and effect %s: %s", (edgeConfidence, effectConfidence, expected) => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, {
        effects: [localEffect({ id: "db.write", target: "x", confidence: effectConfidence })],
      }),
    ]

    const { symbols: out } = propagateEffects({
      symbols,
      edges: [edge(A, B, { confidence: edgeConfidence })],
    })

    expect(propagatedOf(out, A).map((e) => e.confidence)).toEqual([expected])
  })

  it("is the stronger of two paths", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C),
      makeSymbol(D, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [
      edge(A, B, { confidence: "medium" }),
      edge(A, C, { confidence: "high" }),
      edge(B, D),
      edge(C, D),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.confidence)).toEqual(["high"])
  })

  it("takes the strongest of several call sites between one pair", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [
      edge(A, B, { confidence: "low", line: 5 }),
      edge(A, B, { confidence: "high", line: 12 }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.confidence)).toEqual(["high"])
  })

  it("takes the strongest of the edges leaving a cycle for one callee", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [
      edge(A, B),
      edge(B, A),
      edge(A, C, { confidence: "low" }),
      edge(B, C, { confidence: "high" }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A)).toMatchObject([{ confidence: "high", derivedFrom: [B, C] }])
  })
})

describe("the classification a propagated effect carries", () => {
  it("is the callee's with the smaller derivedBy, plugin and derivedBy together", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, {
        effects: [
          localEffect({ id: "db.write", target: "x", derivedBy: "effects-plugin:z", plugin: "z" }),
        ],
      }),
      makeSymbol(C, {
        effects: [
          localEffect({ id: "db.write", target: "x", derivedBy: "effects-plugin:a", plugin: "a" }),
        ],
      }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, B), edge(A, C)] })

    expect(propagatedOf(out, A)).toMatchObject([{ derivedBy: "effects-plugin:a", plugin: "a" }])
  })

  it("stays the one a member of the caller's cycle detected, over a smaller one from below", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, {
        effects: [
          localEffect({ id: "db.write", target: "x", derivedBy: "effects-plugin:z", plugin: "z" }),
        ],
      }),
      makeSymbol(C, {
        effects: [
          localEffect({ id: "db.write", target: "x", derivedBy: "effects-plugin:a", plugin: "a" }),
        ],
      }),
    ]
    const edges = [edge(A, B), edge(B, A), edge(A, C)]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A)).toMatchObject([
      { derivedBy: "effects-plugin:z", plugin: "z", derivedFrom: [B, C] },
    ])
  })
})

describe("the effects[] a symbol ends with", () => {
  it("lists locals first in call order, then propagated entries by (id, target)", () => {
    const symbols = [
      makeSymbol(A, {
        effects: [
          localEffect({ id: "x.write", target: "aaa", line: 30 }),
          localEffect({ id: "a.read", target: "aaa", line: 45 }),
        ],
      }),
      makeSymbol(B, {
        effects: [
          localEffect({ id: "queue.publish", target: "q" }),
          localEffect({ id: "db.write", target: "prisma.x.create" }),
        ],
      }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, B)] })

    expect(effectsOf(out, A).map((e) => [e.id, e.propagated === true])).toEqual([
      ["x.write", false],
      ["a.read", false],
      ["db.write", true],
      ["queue.publish", true],
    ])
  })

  it("orders propagated targets by UTF-16 code unit, as the serializer reads them", () => {
    const composed = "caf\u00e9"
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, {
        effects: [
          localEffect({ id: "db.write", target: composed }),
          localEffect({ id: "db.write", target: "cafz" }),
        ],
      }),
    ]

    const { symbols: out } = propagateEffects({ symbols, edges: [edge(A, B)] })

    expect(propagatedOf(out, A).map((e) => e.target)).toEqual(["cafz", composed])
  })

  it("is the same whatever order the symbols and edges arrive in", () => {
    const symbols = [
      makeSymbol("ts:src/top.ts#top"),
      makeSymbol("ts:src/left.ts#left", { effects: [localEffect({ id: "db.read", target: "r" })] }),
      makeSymbol("ts:src/right.ts#right", {
        effects: [localEffect({ id: "db.write", target: "w" })],
      }),
      makeSymbol("ts:src/bottom.ts#bottom", {
        effects: [localEffect({ id: "network.http", target: "fetch" })],
      }),
    ]
    const edges = [
      edge("ts:src/top.ts#top", "ts:src/left.ts#left"),
      edge("ts:src/top.ts#top", "ts:src/right.ts#right"),
      edge("ts:src/left.ts#left", "ts:src/bottom.ts#bottom"),
      edge("ts:src/right.ts#right", "ts:src/bottom.ts#bottom"),
    ]

    const forward = propagateEffects({ symbols, edges })
    const reversed = propagateEffects({
      symbols: [...symbols].reverse(),
      edges: [...edges].reverse(),
    })

    expect([...reversed.symbols].reverse()).toEqual(forward.symbols)
  })

  it("is unchanged by a second pass over the first pass's output", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]
    const edges = [edge(A, B)]

    const pass1 = propagateEffects({ symbols, edges })
    const pass2 = propagateEffects({ symbols: pass1.symbols, edges })

    expect(pass2.symbols).toEqual(pass1.symbols)
  })
})

describe("propagateEffects", () => {
  it("reports the shape of the graph it swept", () => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B),
      makeSymbol(C, { effects: [localEffect({ id: "db.write", target: "x" })] }),
    ]

    const { stats } = propagateEffects({ symbols, edges: [edge(A, B), edge(B, C)] })

    expect(stats).toEqual({
      sccCount: 3,
      maxSccSize: 1,
      propagatedEffectCount: 2,
      symbolsWithPropagatedEffects: 2,
    })
  })

  it.each<[string, CallEdge]>([
    ["from", edge("ts:ghost.ts#Ghost", A)],
    ["to", edge(A, "ts:ghost.ts#Ghost")],
  ])("refuses an edge whose %s is not among the symbols", (end, dangling) => {
    expect(() => propagateEffects({ symbols: [makeSymbol(A)], edges: [dangling] })).toThrowError(
      expect.objectContaining({
        code: "propagation-invariant-violated",
        message: expect.stringContaining(`CallEdge.${end}`),
      }),
    )
  })
})
