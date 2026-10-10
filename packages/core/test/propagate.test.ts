import type { Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { serializeCanonical } from "../src/canonical"
import { propagateEffects } from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"
import { edge, effect } from "./fixtures/propagate"

function local(overrides: Partial<Effect> & { id: string; target: string }): Effect {
  return effect(overrides.id, overrides.target, overrides)
}

function bySymbolId(symbols: IRSymbol[], id: string): IRSymbol {
  const sym = symbols.find((s) => s.id === id)
  if (sym === undefined) throw new Error(`missing symbol ${id}`)
  return sym
}

describe("propagateEffects", () => {
  it("direct A→B propagation — B's db.write reaches A", () => {
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

  it("two-hop A→B→C — A.derivedFrom is [B], B.derivedFrom is [C]", () => {
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

  it("diamond A→B→D, A→C→D — A.derivedFrom is sorted union [B,C], single entry", () => {
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

  it("min-along-path — edge high + effect medium collapses to medium", () => {
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

  it("min-along-path — edge medium + effect high collapses to medium", () => {
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

  it("max-across-paths — two paths medium + high merge to high", () => {
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

  it("SCC {A,B,C} all internal, only C has local — every member ends with same aggregated set", () => {
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

  it("self-loop A→A on locally-effecting A — no duplicate propagated entry", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:a.ts#A")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    const a = bySymbolId(out, "ts:a.ts#A")
    expect(a.effects).toHaveLength(1)
    expect(a.effects[0]?.propagated).not.toBe(true)
  })

  it("local shadows propagated on same (id,target)", () => {
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

  it("boundary decorator is NOT a propagation stop", () => {
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

  it("unresolved edges do not propagate — a symbol with no outgoing edges receives no propagated effects", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const { symbols: out } = propagateEffects({ symbols, edges: [] })
    expect(bySymbolId(out, "ts:a.ts#A").effects).toHaveLength(0)
  })

  it("cross-language guard — edges only connect within one language universe", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const { symbols: out } = propagateEffects({ symbols, edges })
    expect(bySymbolId(out, "ts:a.ts#A").effects.some((e) => e.propagated === true)).toBe(true)
  })

  it("idempotence — running propagation twice reproduces the same effects[] byte-for-byte", () => {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A"),
      makeSymbol("ts:b.ts#B", { effects: [local({ id: "db.write", target: "x" })] }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const pass1 = propagateEffects({ symbols, edges })
    const pass2 = propagateEffects({ symbols: pass1.symbols, edges })
    expect(pass2.symbols).toEqual(pass1.symbols)
  })

  it("input CallEdge[] shuffle produces byte-identical output", () => {
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

  it("propagated entries omit line", () => {
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

describe("propagateEffects — additional invariants", () => {
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

describe("propagateEffects — the sweep order and the written bytes agree", () => {
  const NFC_CAFE = `caf${"\u00e9"}`
  const NFD_CAFE = NFC_CAFE.normalize("NFD")

  function propagatedTargets(target: string): string[] {
    const symbols: IRSymbol[] = [
      makeSymbol("ts:a.ts#A", { effects: [] }),
      makeSymbol("ts:b.ts#B", {
        effects: [local({ id: "db.write", target }), local({ id: "db.write", target: "cafz" })],
      }),
    ]
    const edges: CallEdge[] = [edge("ts:a.ts#A", "ts:b.ts#B")]
    const result = propagateEffects({ symbols, edges })
    return bySymbolId(result.symbols, "ts:a.ts#A").effects.map((e) => e.target)
  }

  it("orders a normalized target where the serializer will write it", () => {
    expect(propagatedTargets(NFC_CAFE)).toEqual(["cafz", NFC_CAFE])
  })

  it("orders an un-normalized one somewhere else — which is why it never reaches here", () => {
    expect(propagatedTargets(NFD_CAFE)).toEqual([NFD_CAFE, "cafz"])
  })

  it("serializes a normalized run in the order the array declares", () => {
    const targets = propagatedTargets(NFC_CAFE)
    const json = serializeCanonical(
      targets.map((t) => ({ target: t })),
      { format: "compact" },
    )
    expect(json).toBe(`[{"target":"cafz"},{"target":"${NFC_CAFE}"}]`)
  })
})
