import type { Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { propagateEffects } from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"
import { edge, effect } from "./fixtures/propagate"

/**
 * Object-literal wrapper over the shared `effect` builder, keeping this file's call sites
 * (`local({ id, target, confidence })`) readable where several fields are overridden.
 */
function local(overrides: Partial<Effect> & { id: string; target: string }): Effect {
  return effect(overrides.id, overrides.target, overrides)
}

function bySymbolId(symbols: IRSymbol[], id: string): IRSymbol {
  const sym = symbols.find((s) => s.id === id)
  if (sym === undefined) throw new Error(`missing symbol ${id}`)
  return sym
}

describe("propagateEffects — PR1..PR15 (effect-propagation.md §11)", () => {
  it("PR1: direct A→B propagation — B's db.write reaches A", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", { effects: [] }),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target: "prisma.invoice.create", line: 8 })],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A")
    const propagated = a.effects.filter((e) => e.propagated === true)
    expect(propagated).toHaveLength(1)
    expect(propagated[0]?.id).toBe("db.write")
    expect(propagated[0]?.target).toBe("prisma.invoice.create")
    expect(propagated[0]?.derivedFrom).toEqual(["ts:b.ts#B"])
    expect(propagated[0]?.line).toBeUndefined()
  })

  it("PR2: two-hop A→B→C — A.derivedFrom is [B], B.derivedFrom is [C]", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C", { effects: [local({ id: "db.write", target: "prisma.x.create" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B"), edge("ts:b.ts#B", "ts:c.ts#C")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    expect(
      bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)?.derivedFrom,
    ).toEqual(["ts:b.ts#B"])
    expect(
      bySymbolId(out, "ts:b.ts#B").effects.find((e) => e.propagated === true)?.derivedFrom,
    ).toEqual(["ts:c.ts#C"])
    // C has only its local effect, no propagated entry.
    expect(bySymbolId(out, "ts:c.ts#C").effects.every((e) => e.propagated !== true)).toBe(true)
  })

  it("PR3: diamond A→B→D, A→C→D — A.derivedFrom is sorted union [B,C], single entry", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C"),
      makeSymbol("ts:d.ts#D", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B"),
      edge("ts:a.ts#A", "ts:c.ts#C"),
      edge("ts:b.ts#B", "ts:d.ts#D"),
      edge("ts:c.ts#C", "ts:d.ts#D"),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A").effects.filter((e) => e.propagated === true)
    expect(a).toHaveLength(1)
    expect(a[0]?.derivedFrom).toEqual(["ts:b.ts#B", "ts:c.ts#C"])
  })

  it("PR4: min-along-path — edge high + effect medium collapses to medium", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target: "x", confidence: "medium" })],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B", { confidence: "high" })]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.confidence).toBe("medium")
  })

  it("PR4b: min-along-path — edge medium + effect high collapses to medium", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B", { confidence: "medium" })]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.confidence).toBe("medium")
  })

  it("PR5: max-across-paths — two paths medium + high merge to high", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C"),
      makeSymbol("ts:d.ts#D", {
        effects: [local({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]
    const edges: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B", { confidence: "medium" }),
      edge("ts:a.ts#A", "ts:c.ts#C", { confidence: "high" }),
      edge("ts:b.ts#B", "ts:d.ts#D", { confidence: "high" }),
      edge("ts:c.ts#C", "ts:d.ts#D", { confidence: "high" }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.confidence).toBe("high")
  })

  it("PR6: SCC {A,B,C} all internal, only C has local — every member ends with same aggregated set", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B"),
      edge("ts:b.ts#B", "ts:c.ts#C"),
      edge("ts:c.ts#C", "ts:a.ts#A"),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    for (const id of ["ts:a.ts#A", "ts:b.ts#B", "ts:c.ts#C"]) {
      const entries = bySymbolId(out, id).effects.filter(
        (e) => e.id === "db.write" && e.target === "x",
      )
      expect(entries.length).toBeGreaterThanOrEqual(1)
    }
    const c = bySymbolId(out, "ts:c.ts#C").effects
    expect(c.some((e) => e.propagated !== true && e.id === "db.write")).toBe(true)
  })

  it("PR7: self-loop A→A on locally-effecting A — no duplicate propagated entry", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:a.ts#A")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A")
    expect(a.effects).toHaveLength(1)
    expect(a.effects[0]?.propagated).not.toBe(true)
  })

  it("PR8: local shadows propagated on same (id,target)", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", {
        effects: [local({ id: "db.write", target: "x", line: 42, confidence: "medium" })],
      }),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A")
    expect(a.effects).toHaveLength(1)
    expect(a.effects[0]?.propagated).not.toBe(true)
    expect(a.effects[0]?.line).toBe(42)
    expect(a.effects[0]?.confidence).toBe("medium")
  })

  it("PR9: boundary decorator is NOT a propagation stop", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:ctl.ts#Ctl", {
        decorators: [{ name: "Post", raw: "Post()", arguments: [], boundary: true, line: 1 }],
      }),
      makeSymbol("ts:svc.ts#Svc"),
      makeSymbol("ts:repo.ts#Repo", {
        effects: [local({ id: "db.write", target: "prisma.invoice.create" })],
      }),
    ]
    const edges: CallEdge[] = [
      edge("ts:ctl.ts#Ctl", "ts:svc.ts#Svc"),
      edge("ts:svc.ts#Svc", "ts:repo.ts#Repo"),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const ctl = bySymbolId(out, "ts:ctl.ts#Ctl")
    expect(ctl.effects.some((e) => e.propagated === true && e.id === "db.write")).toBe(true)
  })

  it("PR10: unresolved edges do not propagate — a symbol with no outgoing edges receives no propagated effects", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges: [] })
    expect(bySymbolId(out, "ts:a.ts#A").effects).toHaveLength(0)
  })

  it("PR11: cross-language guard — edges only connect within one language universe", () => {
    // The propagate pass does not enforce language separation itself — the call-graph
    // resolver upstream never emits cross-language edges. Emulate: only intra-language
    // edges are provided, and propagation must still function per-language.
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    expect(bySymbolId(out, "ts:a.ts#A").effects.some((e) => e.propagated === true)).toBe(true)
  })

  it("PR13: idempotence — running propagation twice reproduces the same effects[] byte-for-byte", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const pass1 = propagateEffects({ symbols, edges })
    const pass2 = propagateEffects({ symbols: pass1.symbols, edges })
    expect(pass2.symbols).toEqual(pass1.symbols)
  })

  it("PR14: input CallEdge[] shuffle produces byte-identical output", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C"),
      makeSymbol("ts:d.ts#D", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const canonical: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B"),
      edge("ts:a.ts#A", "ts:c.ts#C"),
      edge("ts:b.ts#B", "ts:d.ts#D"),
      edge("ts:c.ts#C", "ts:d.ts#D"),
    ]
    const shuffled: CallEdge[] = [
      canonical[3],
      canonical[1],
      canonical[2],
      canonical[0],
    ] as CallEdge[]
    const a = propagateEffects({ symbols, edges: canonical })
    const b = propagateEffects({ symbols, edges: shuffled })
    expect(b.symbols).toEqual(a.symbols)
  })

  it("PR15: propagated entries omit line", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x", line: 99 })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.line).toBeUndefined()
  })
})

describe("propagateEffects — additional invariants (§5, §8, §12.9)", () => {
  it("derivedBy lex tie-break — two paths, smaller derivedBy wins", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", {
        effects: [
          local({
            id: "db.write",
            target: "x",
            derivedBy: "effects-plugin:z:write",
            plugin: "effects-z",
          }),
        ],
      }),
      makeSymbol("ts:c.ts#C", {
        effects: [
          local({
            id: "db.write",
            target: "x",
            derivedBy: "effects-plugin:a:write",
            plugin: "effects-a",
          }),
        ],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B"), edge("ts:a.ts#A", "ts:c.ts#C")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.derivedBy).toBe("effects-plugin:a:write")
    expect(prop?.plugin).toBe("effects-a")
  })

  it("derivedFrom is the direct callee, not the full chain", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B"), edge("ts:b.ts#B", "ts:c.ts#C")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    expect(
      bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)?.derivedFrom,
    ).toEqual(["ts:b.ts#B"])
  })

  it("emission order: locals in call order first, propagated after sorted by (id, target)", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", {
        effects: [
          // Local effects are seeded at lines 30 then 45 — call order should be preserved.
          local({ id: "x.write", target: "aaa", line: 30 }),
          local({ id: "a.read", target: "aaa", line: 45 }),
        ],
      }),
      makeSymbol("ts:b.ts#B", {
        effects: [
          local({ id: "queue.publish", target: "q" }),
          local({ id: "db.write", target: "prisma.x.create" }),
        ],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A").effects
    // Local segment first (call order).
    expect(a[0]?.propagated).not.toBe(true)
    expect(a[1]?.propagated).not.toBe(true)
    expect(a[0]?.id).toBe("x.write")
    expect(a[1]?.id).toBe("a.read")
    // Propagated segment sorted by (id, target).
    expect(a[2]?.propagated).toBe(true)
    expect(a[3]?.propagated).toBe(true)
    expect(a[2]?.id).toBe("db.write")
    expect(a[3]?.id).toBe("queue.publish")
  })

  it("local segment retains call order verbatim (target sort does not touch it)", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", {
        effects: [
          local({ id: "db.write", target: "zzz", line: 10 }),
          local({ id: "db.read", target: "aaa", line: 20 }),
        ],
      }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges: [] })
    const a = bySymbolId(out, "ts:a.ts#A").effects
    expect(a.map((e) => e.target)).toEqual(["zzz", "aaa"])
  })

  it("PropagationStats reflects graph shape", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B"), edge("ts:b.ts#B", "ts:c.ts#C")]
    const { stats } = propagateEffects({ symbols, edges })
    expect(stats.sccCount).toBe(3)
    expect(stats.maxSccSize).toBe(1)
    expect(stats.propagatedEffectCount).toBe(2)
    expect(stats.symbolsWithPropagatedEffects).toBe(2)
  })
})

describe("propagateEffects — coverage for merge / condense internals", () => {
  it("multiple call sites on the same (from,to) collapse to the max edge confidence", () => {
    // Two edges A→B with confidences (low, high) MUST be treated as one edge with
    // confidence=high; the propagated entry then survives min-along-path with B's
    // high-confidence local at high. If the pair silently kept the first-seen edge
    // (low), min(low, high) would demote the propagated confidence to low.
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]
    const edges: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B", { confidence: "low", line: 5 }),
      edge("ts:a.ts#A", "ts:b.ts#B", { confidence: "high", line: 12 }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.confidence).toBe("high")
  })

  it("condense collapses parallel SCC→SCC edges by max confidence", () => {
    // Multi-member SCC {A, B} calling out to a downstream SCC {C}, with A→C at
    // low confidence and B→C at high confidence. `condense()` MUST aggregate the
    // pair (fromScc=SCC{A,B}, toScc=SCC{C}) with the max, so A's propagated entry
    // ends up at min(high, high)=high — not min(low, high)=low.
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B"),
      makeSymbol("ts:c.ts#C", {
        effects: [local({ id: "db.write", target: "x", confidence: "high" })],
      }),
    ]
    const edges: CallEdge[] = [
      edge("ts:a.ts#A", "ts:b.ts#B"),
      edge("ts:b.ts#B", "ts:a.ts#A"),
      edge("ts:a.ts#A", "ts:c.ts#C", { confidence: "low" }),
      edge("ts:b.ts#B", "ts:c.ts#C", { confidence: "high" }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.confidence).toBe("high")
    expect(prop?.derivedFrom).toEqual(["ts:b.ts#B", "ts:c.ts#C"])
  })

  it("plugin and derivedBy stay locked together on the winning tie-break", () => {
    // The invariant: for a purely propagated aggregate entry, `derivedBy` and
    // `plugin` reflect the SAME upstream classification. A reader must never see
    // "derivedBy says plugin A, plugin field says plugin B".
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", {
        effects: [
          local({
            id: "db.write",
            target: "x",
            derivedBy: "effects-plugin:z:write",
            plugin: "effects-z",
          }),
        ],
      }),
      makeSymbol("ts:c.ts#C", {
        effects: [
          local({
            id: "db.write",
            target: "x",
            derivedBy: "effects-plugin:a:write",
            plugin: "effects-a",
          }),
        ],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B"), edge("ts:a.ts#A", "ts:c.ts#C")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const prop = bySymbolId(out, "ts:a.ts#A").effects.find((e) => e.propagated === true)
    expect(prop?.derivedBy).toBe("effects-plugin:a:write")
    expect(prop?.plugin).toBe("effects-a")
  })

  it("throws when a CallEdge endpoint is not in the input symbols", () => {
    const symbols: IRSymbol[] = [makeSymbol("ts:a.ts#A")]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:ghost.ts#Ghost")]
    expect(() => propagateEffects({ symbols, edges })).toThrow(/CallEdge\.to/)
  })
})
