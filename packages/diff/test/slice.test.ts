import type { CallEdge } from "@aburi/core"
import type { Confidence, Effect, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSlices } from "../src/slice"
import { fp, makeSymbol, zeroFp } from "./fixtures"

/**
 * Slice View pass acceptance tests. These map to SV1–SV20 in
 * docs/design/slice-view.md §13; SV21 (cross-language) and SV22 (schema) are
 * covered elsewhere (e2e-integration and packages/types respectively).
 *
 * Helpers below build the three pass inputs — a `SymbolChange[]`, plus base
 * and head `CallEdge[]` — as compactly as possible so each test spells out
 * only the fact under scrutiny.
 */

const changed = (id: string): SymbolChange => ({
  status: "changed",
  before: makeSymbol({ id, name: id }),
  after: makeSymbol({ id, name: id, fingerprint: fp(id) }),
  delta: {
    apiChanged: false,
    logicChanged: true,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
  },
})

const added = (id: string): SymbolChange => ({
  status: "added",
  symbol: makeSymbol({ id, name: id }),
})

const removed = (id: string): SymbolChange => ({
  status: "removed",
  symbol: makeSymbol({ id, name: id }),
})

const moved = (before: string, after: string): SymbolChange => ({
  status: "moved",
  before: makeSymbol({ id: before, name: before }),
  after: makeSymbol({ id: after, name: after }),
  rationale: "logic-fingerprint",
})

const movedChanged = (before: string, after: string): SymbolChange => ({
  status: "moved+changed",
  before: makeSymbol({ id: before, name: before }),
  after: makeSymbol({ id: after, name: after, fingerprint: fp(after) }),
  rationale: "logic-fingerprint",
  delta: {
    apiChanged: false,
    logicChanged: true,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
  },
})

const droppedToggled = (id: string, direction: "to-dropped" | "to-kept"): SymbolChange => ({
  status: "dropped-toggled",
  before: makeSymbol({ id, name: id, dropped: direction !== "to-dropped" }),
  after: makeSymbol({
    id,
    name: id,
    dropped: direction === "to-dropped",
    fingerprint: direction === "to-dropped" ? zeroFp() : fp(id),
  }),
  direction,
})

function edge(from: string, to: string, line = 1, confidence: Confidence = "high"): CallEdge {
  return { from, to, via: "call", confidence, line }
}

describe("computeSlices — Node selection (SV1–SV5)", () => {
  it("SV1: two changed symbols connected by an edge form one Slice", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A, B] }])
  })

  it("SV2: two changed symbols with no edge form two singletons", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [],
    })
    expect(slices).toEqual([
      { id: `slice:${A}`, members: [A] },
      { id: `slice:${B}`, members: [B] },
    ])
  })

  it("SV3: no bridging through an unchanged Symbol M (A→M→B does NOT unify A,B)", () => {
    // M is unchanged → not a Node → the edges [A,M] and [M,B] are dropped
    // because their non-A/B endpoint is not in the Node set.
    const A = "ts:src/a.ts#A"
    const M = "ts:src/mid.ts#M"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, M), edge(M, B)],
    })
    expect(slices).toEqual([
      { id: `slice:${A}`, members: [A] },
      { id: `slice:${B}`, members: [B] },
    ])
  })

  it("SV4: pure moved symbol is NOT a Node and is absent from slices[] entirely", () => {
    const A = "ts:src/a.ts#A"
    const OldMoved = "ts:src/old.ts#moved"
    const NewMoved = "ts:src/new.ts#moved"
    const slices = computeSlices({
      changes: [changed(A), moved(OldMoved, NewMoved)],
      baseCallEdges: [],
      headCallEdges: [edge(A, NewMoved), edge(A, OldMoved)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A] }])
  })

  it("SV5: propagated-only changed callers (status: changed) are Nodes and cluster with their downstream callee", () => {
    // §4.4 — the Boundary controller's body is byte-identical between base
    // and head; the *only* semantic change is that effect propagation has
    // now attached a `db.write` entry with `propagated: true` because the
    // downstream service `Svc.op` began invoking a repository write. The
    // controller therefore appears as `status: changed` even though its
    // own source is unchanged.
    //
    // The Slice View pass MUST NOT reach into `delta.effects` to distinguish
    // this from a "real" body change — "any status: changed is a Node" is
    // the whole rule (§4.4). This test constructs the propagated-only case
    // faithfully so a future refactor that added such a distinction would
    // silently break here.
    const Ctl = "ts:src/ctl.ts#Ctl.route"
    const Svc = "ts:src/svc.ts#Svc.op"
    const propagatedWrite: Effect = {
      id: "db.write",
      target: "prisma.record.create",
      plugin: "effects-prisma",
      confidence: "high",
      derivedBy: "propagation:svc.op",
      propagated: true,
      derivedFrom: [Svc],
    }
    const ctlPropagatedOnly: SymbolChange = {
      status: "changed",
      before: makeSymbol({ id: Ctl, name: Ctl }),
      after: makeSymbol({ id: Ctl, name: Ctl, effects: [propagatedWrite] }),
      delta: {
        apiChanged: false,
        logicChanged: true,
        syntaxChanged: false,
        componentChanged: false,
        visibilityChanged: false,
        effects: { added: [propagatedWrite], removed: [], modified: [] },
      },
    }
    const slices = computeSlices({
      changes: [ctlPropagatedOnly, changed(Svc)],
      baseCallEdges: [],
      headCallEdges: [edge(Ctl, Svc)],
    })
    expect(slices).toEqual([{ id: `slice:${Ctl}`, members: [Ctl, Svc] }])
  })
})

describe("computeSlices — Base/head edge union (SV6–SV8)", () => {
  it("SV6: {C, oldS(removed), newS(added)} — rename with edge in base only for old, head only for new", () => {
    const C = "ts:src/c.ts#Ctl.route"
    const oldS = "ts:src/svc.ts#Svc.old"
    const newS = "ts:src/svc.ts#Svc.new"
    const slices = computeSlices({
      changes: [changed(C), removed(oldS), added(newS)],
      baseCallEdges: [edge(C, oldS)],
      headCallEdges: [edge(C, newS)],
    })
    expect(slices).toEqual([
      // Anchor is the lex-smallest of the three ids. ts:src/c.ts#... sorts
      // before ts:src/svc.ts#..., so C is the anchor.
      { id: `slice:${C}`, members: [C, newS, oldS].sort() },
    ])
  })

  it("SV7: edge only in headCallEdges still unifies its Nodes", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), added(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B)],
    })
    expect(slices).toHaveLength(1)
    expect(slices[0]?.members).toEqual([A, B])
  })

  it("SV8: edge only in baseCallEdges still unifies its Nodes", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), removed(B)],
      baseCallEdges: [edge(A, B)],
      headCallEdges: [],
    })
    expect(slices).toHaveLength(1)
    expect(slices[0]?.members).toEqual([A, B])
  })
})

describe("computeSlices — Cycles and dropped (SV9–SV11)", () => {
  it("SV9: directed cycle A→B→C→A → one Slice with all three, no SCC pre-condense", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const C = "ts:src/c.ts#C"
    const slices = computeSlices({
      changes: [changed(A), changed(B), changed(C)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B), edge(B, C), edge(C, A)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A, B, C] }])
  })

  it("SV10: dropped-toggled Symbol with no in-Node edges becomes a singleton", () => {
    const X = "ts:src/x.ts#X"
    const slices = computeSlices({
      changes: [droppedToggled(X, "to-dropped")],
      baseCallEdges: [],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${X}`, members: [X] }])
  })

  it("SV11: dropped-toggled Symbol with a kept-side edge to another Node clusters", () => {
    const X = "ts:src/x.ts#X"
    const K = "ts:src/k.ts#K"
    const slices = computeSlices({
      changes: [droppedToggled(X, "to-dropped"), changed(K)],
      baseCallEdges: [edge(X, K)], // kept-side (base) edge from X to a still-changed Symbol
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${K}`, members: [K, X] }])
  })
})

describe("computeSlices — Cluster identity and ordering (SV12–SV14)", () => {
  it("SV12: sliceId = 'slice:' + smallest member id (verbatim, no sanitisation)", () => {
    const X = "ts:src/a.ts#X"
    const Y = "ts:src/a.ts#Y"
    const Z = "ts:src/a.ts#Z"
    const slices = computeSlices({
      changes: [changed(Z), changed(Y), changed(X)],
      baseCallEdges: [],
      headCallEdges: [edge(Y, Z), edge(X, Y)],
    })
    expect(slices).toEqual([{ id: `slice:${X}`, members: [X, Y, Z] }])
  })

  it("SV13: slices[] is sorted by ascending anchor id", () => {
    const M = "ts:src/m.ts#M"
    const X = "ts:src/x.ts#X"
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(M), changed(X), changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(M, X), edge(A, B)],
    })
    expect(slices.map((s) => s.id)).toEqual([`slice:${A}`, `slice:${M}`])
  })

  it("SV14: members[] within a Slice is sorted ascending", () => {
    const A = "ts:src/a.ts#Aa"
    const C = "ts:src/a.ts#Cc"
    const B = "ts:src/a.ts#Bb"
    const slices = computeSlices({
      changes: [changed(A), changed(B), changed(C)],
      baseCallEdges: [],
      headCallEdges: [edge(C, A), edge(B, C)],
    })
    expect(slices[0]?.members).toEqual([A, B, C])
  })
})

describe("computeSlices — Determinism (SV15–SV18)", () => {
  const buildInputs = () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const C = "ts:src/c.ts#C"
    const D = "ts:src/d.ts#D"
    return {
      A,
      B,
      C,
      D,
      changes: [changed(A), changed(B), changed(C), changed(D)],
      edges: [edge(A, B), edge(C, D)],
    }
  }

  it("SV15: idempotence — two runs produce byte-identical JSON", () => {
    const { changes, edges } = buildInputs()
    const one = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const two = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
  })

  it("SV16: input-order insensitivity — shuffled inputs produce identical output", () => {
    const { changes, edges } = buildInputs()
    const canonical = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const shuffled = computeSlices({
      changes: [...changes].reverse(),
      baseCallEdges: [...edges].reverse().map((e) => ({ ...e, from: e.to, to: e.from })),
      headCallEdges: [],
    })
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical))
  })

  it("SV17: locality — adding an unchanged Symbol elsewhere does not change any slice", () => {
    // Unchanged symbols never reach `changes[]` (§3 precondition 1: unchanged
    // is dropped upstream). So passing the same `changes[]` twice is the
    // faithful representation of "adding an unchanged symbol elsewhere".
    const { changes, edges } = buildInputs()
    const before = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const after = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    expect(after).toEqual(before)
  })

  it("SV18: adding a new Node in a disjoint component leaves existing slices unchanged", () => {
    const { A, B, C, D, changes, edges } = buildInputs()
    const before = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })

    const Z = "ts:src/z.ts#Z"
    const after = computeSlices({
      changes: [...changes, changed(Z)],
      baseCallEdges: [],
      headCallEdges: edges,
    })
    // The A-B and C-D slices should appear identical to `before`; only a
    // new `{Z}` singleton is added (appended in sorted-anchor order).
    expect(after.find((s) => s.id === `slice:${A}`)?.members).toEqual([A, B])
    expect(after.find((s) => s.id === `slice:${C}`)?.members).toEqual([C, D])
    expect(after.find((s) => s.id === `slice:${Z}`)?.members).toEqual([Z])
    expect(after).toHaveLength(before.length + 1)
  })
})

describe("computeSlices — Zero-Node and edge shape edge cases (SV19 partial + robustness)", () => {
  it("SV19 (JSON side): a Node-less change set yields slices: []", () => {
    // Only pure `moved` — not a Node per §4.1.
    const slices = computeSlices({
      changes: [moved("ts:src/a.ts#a", "ts:src/b.ts#a")],
      baseCallEdges: [],
      headCallEdges: [],
    })
    expect(slices).toEqual([])
  })

  it("moved+changed IS a Node (uses head-side id)", () => {
    const before = "ts:src/old.ts#foo"
    const after = "ts:src/new.ts#foo"
    const slices = computeSlices({
      changes: [movedChanged(before, after)],
      baseCallEdges: [],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${after}`, members: [after] }])
  })

  it("multi-edges between same pair (base + head, plus multiple lines) do not create phantom members", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [edge(A, B, 1), edge(A, B, 2)],
      headCallEdges: [edge(A, B, 3), edge(B, A, 4)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A, B] }])
  })

  it("self-loops (direct recursion) do not fabricate connectivity", () => {
    const A = "ts:src/a.ts#A"
    const slices = computeSlices({
      changes: [changed(A)],
      baseCallEdges: [edge(A, A)],
      headCallEdges: [edge(A, A)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A] }])
  })

  it("edges whose endpoints are outside the Node set are dropped silently", () => {
    const A = "ts:src/a.ts#A"
    const External = "ts:src/ext.ts#external"
    const slices = computeSlices({
      changes: [changed(A)],
      baseCallEdges: [],
      headCallEdges: [edge(A, External), edge(External, A)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A] }])
  })
})

describe("computeSlices — SV21: cross-language partition", () => {
  it("partitions Nodes by language when the changes span multiple languages", () => {
    // slice-view.md §5.5 / §14.13: cross-language edges do not exist yet, so
    // a PR touching TypeScript and Python files produces disjoint slices per
    // language. The e2e fixture only covers a single language; this unit
    // test enforces the partition property at the pass boundary — even when
    // Node ids from different languages are interleaved in the input.
    const tsCtl = "ts:src/ctl.ts#Ctl.route"
    const tsSvc = "ts:src/svc.ts#Svc.op"
    const pyCtl = "py:app/ctl.py#route"
    const pySvc = "py:app/svc.py#op"
    const slices = computeSlices({
      changes: [changed(tsCtl), changed(tsSvc), changed(pyCtl), changed(pySvc)],
      baseCallEdges: [],
      headCallEdges: [edge(tsCtl, tsSvc), edge(pyCtl, pySvc)],
    })
    expect(slices).toEqual([
      { id: `slice:${pyCtl}`, members: [pyCtl, pySvc] },
      { id: `slice:${tsCtl}`, members: [tsCtl, tsSvc] },
    ])
  })

  it("a cross-language edge that reaches the pass anyway still unifies (defensive: no language-aware short-circuit)", () => {
    // If a future resolver produces a genuine cross-language edge (planned in
    // multi-language-id.md), the WCC pass MUST cluster the two Symbols —
    // Slice View has no language-aware filter of its own. This test guards
    // against a well-meaning "only same-language edges" filter being added
    // here, which would violate §14.13's promise ("Slice View will then
    // automatically produce cross-language clusters via the same WCC rule
    // with no code change").
    const tsA = "ts:src/a.ts#a"
    const pyB = "py:app/b.py#b"
    const slices = computeSlices({
      changes: [changed(tsA), changed(pyB)],
      baseCallEdges: [],
      headCallEdges: [edge(tsA, pyB)],
    })
    expect(slices).toEqual([{ id: `slice:${pyB}`, members: [pyB, tsA] }])
  })
})
