import { makeIR, seeded, symbolById } from "@aburi/test-support"
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
const X = "ts:x.ts#X"
const Y = "ts:y.ts#Y"

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

  it.each<[string, CallEdge[]]>([
    ["without", []],
    ["with", [edge(B, A, { confidence: "low" })]],
  ])("is the weakest hop's on the only path to it, %s a call back into the caller", (_case, back) => {
    const symbols = [
      makeSymbol(A),
      makeSymbol(B, { effects: [localEffect({ id: "db.write", target: "x" })] }),
      makeSymbol(X),
    ]
    const edges = [edge(X, A), edge(A, B, { confidence: "low" }), ...back]

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(propagatedOf(out, A).map((e) => e.confidence)).toEqual(["low"])
    expect(propagatedOf(out, X).map((e) => e.confidence)).toEqual(["low"])
  })

  it.each<[string, Array<[string, Confidence]>, CallEdge[], Array<[string, Confidence]>]>([
    [
      "is each cycle member's own, and a caller outside the cycle reads the member it calls",
      [[C, "high"]],
      [edge(A, B, { confidence: "low" }), edge(B, A), edge(B, C), edge(X, A), edge(Y, B)],
      [
        [A, "low"],
        [B, "high"],
        [X, "low"],
        [Y, "high"],
      ],
    ],
    [
      "is the stronger of a cycle member's own call out of the cycle and another member's",
      [[C, "high"]],
      [edge(A, B), edge(B, A), edge(A, C, { confidence: "low" }), edge(B, C)],
      [[A, "high"]],
    ],
    [
      "stays at a weak write's around a cycle of strong calls",
      [[B, "low"]],
      [edge(A, B), edge(B, A), edge(X, A)],
      [
        [A, "low"],
        [X, "low"],
      ],
    ],
    [
      "rises again on a cycle member's callers when that member rises after reaching them",
      [
        [B, "high"],
        [C, "low"],
      ],
      [edge(A, C), edge(C, B), edge(B, A, { confidence: "low" }), edge(X, A)],
      [
        [A, "high"],
        [X, "high"],
      ],
    ],
    [
      "is the callee's best path's, above the callee's own weaker entry",
      [
        [A, "low"],
        [B, "high"],
      ],
      [edge(X, A), edge(A, B)],
      [[X, "high"]],
    ],
  ])("%s", (_case, locals, edges, expected) => {
    const localOf = new Map(locals)
    const symbols = [...new Set(edges.flatMap((e) => [e.from, e.to]))].map((id) => {
      const confidence = localOf.get(id)
      return makeSymbol(id, {
        effects:
          confidence === undefined
            ? []
            : [localEffect({ id: "db.write", target: "x", confidence })],
      })
    })

    const { symbols: out } = propagateEffects({ symbols, edges })

    expect(expected.map(([id]) => [id, propagatedOf(out, id).map((e) => e.confidence)])).toEqual(
      expected.map(([id, confidence]) => [id, [confidence]]),
    )
  })
})

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"]

/** Every Symbol's confidence per target: local evidence, then edges relaxed until nothing rises. */
function relaxToFixedPoint(
  symbols: readonly IRSymbol[],
  edges: readonly CallEdge[],
): Map<string, Map<string, Confidence>> {
  const reached = new Map<string, Map<string, Confidence>>(symbols.map((s) => [s.id, new Map()]))
  const raise = (id: string, target: string, offered: Confidence): boolean => {
    const held = reached.get(id)?.get(target)
    if (held !== undefined && RANK[held] >= RANK[offered]) return false
    reached.get(id)?.set(target, offered)
    return true
  }
  for (const s of symbols) for (const e of s.effects) raise(s.id, e.target, e.confidence)
  for (let changed = true; changed; ) {
    changed = false
    for (const { from, to, confidence } of edges) {
      for (const [target, carried] of reached.get(to) ?? []) {
        const offered = RANK[confidence] < RANK[carried] ? confidence : carried
        if (raise(from, target, offered)) changed = true
      }
    }
  }
  return reached
}

function expectedByFixedPoint(
  symbols: readonly IRSymbol[],
  edges: readonly CallEdge[],
  reached: ReadonlyMap<string, ReadonlyMap<string, Confidence>>,
): IRSymbol[] {
  return symbols.map((s) => {
    const local = new Set(s.effects.map((e) => e.target))
    const propagated = [...(reached.get(s.id) ?? [])]
      .filter(([target]) => !local.has(target))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([target, confidence]): Effect => ({
          id: "db.write",
          target,
          plugin: "effects-test",
          confidence,
          derivedBy: "convention:test",
          propagated: true,
          derivedFrom: [
            ...new Set(
              edges
                .filter((e) => e.from === s.id && reached.get(e.to)?.has(target))
                .map((e) => e.to),
            ),
          ].sort(),
        }),
      )
    return { ...s, effects: [...s.effects, ...propagated] }
  })
}

function randomGraph(random: () => number): { symbols: IRSymbol[]; edges: CallEdge[] } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const ids = Array.from({ length: 2 + Math.floor(random() * 5) }, (_, i) => `ts:n${i}.ts#f`)
  const symbols = ids.map((id) =>
    makeSymbol(id, {
      effects:
        random() < 0.4
          ? Array.from({ length: 1 + Math.floor(random() * 2) }, (_, line) =>
              localEffect({
                id: "db.write",
                target: pick(["t0", "t1", "t2"]),
                confidence: pick(CONFIDENCES),
                line: line + 1,
              }),
            )
          : [],
    }),
  )
  const edges: CallEdge[] = []
  for (const from of ids) {
    for (const to of ids) {
      if (random() >= 0.35) continue
      edges.push(edge(from, to, { confidence: pick(CONFIDENCES) }))
      if (random() < 0.15) edges.push(edge(from, to, { confidence: pick(CONFIDENCES), line: 2 }))
    }
  }
  return { symbols, edges }
}

function generatedGraphs(): Array<{ symbols: IRSymbol[]; edges: CallEdge[] }> {
  const random = seeded(20261018)
  return Array.from({ length: 500 }, () => randomGraph(random))
}

function reachableFrom(edges: readonly CallEdge[], from: string): Set<string> {
  const seen = new Set<string>()
  const pending = [from]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const e of edges) {
      if (e.from !== id || seen.has(e.to)) continue
      seen.add(e.to)
      pending.push(e.to)
    }
  }
  return seen
}

/** Whether two Symbols that reach each other settle at different confidences in one target. */
function cycleMembersApart(
  edges: readonly CallEdge[],
  reached: ReadonlyMap<string, ReadonlyMap<string, Confidence>>,
): boolean {
  const reach = new Map([...reached.keys()].map((id) => [id, reachableFrom(edges, id)]))
  const inOneCycle = (a: string, b: string): boolean =>
    a !== b && reach.get(a)?.has(b) === true && reach.get(b)?.has(a) === true
  return [...reached].some(([a, byTarget]) =>
    [...reached].some(
      ([b, other]) =>
        inOneCycle(a, b) &&
        [...byTarget].some(([target, confidence]) => other.get(target) !== confidence),
    ),
  )
}

describe("propagateEffects against a plain fixed-point iteration over the whole graph", () => {
  it("gives every Symbol the effects, confidence and derivedFrom the iteration settles on", () => {
    let trialsWithCycleMembersApart = 0
    for (const [trial, { symbols, edges }] of generatedGraphs().entries()) {
      const reached = relaxToFixedPoint(symbols, edges)

      const { symbols: out } = propagateEffects({ symbols, edges })

      expect(out, `trial ${trial}`).toEqual(expectedByFixedPoint(symbols, edges, reached))
      if (cycleMembersApart(edges, reached)) trialsWithCycleMembersApart += 1
    }
    expect(trialsWithCycleMembersApart).toBeGreaterThan(100)
  })

  it("settles there again over its own output, whatever confidence its propagated entries carry", () => {
    for (const [trial, { symbols, edges }] of generatedGraphs().entries()) {
      const { symbols: out } = propagateEffects({ symbols, edges })
      const raised = out.map((s) => ({
        ...s,
        effects: s.effects.map(
          (e): Effect => (e.propagated === true ? { ...e, confidence: "high" } : e),
        ),
      }))

      expect(propagateEffects({ symbols: out, edges }).symbols, `trial ${trial}`).toEqual(out)
      expect(
        propagateEffects({ symbols: raised, edges }).symbols,
        `trial ${trial}, raised`,
      ).toEqual(out)
    }
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
