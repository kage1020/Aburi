import type { CallEdge } from "@aburi/core"
import { fp, makeSymbol, sliceId, symbolId, zeroFp } from "@aburi/test-support"
import type { Confidence, Effect, SliceRecord, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DiffError } from "../src/errors"
import {
  assertSliceRecordInvariant,
  computeSlices,
  type SliceViolationKind,
  sliceAnchor,
  sliceRecordViolation,
} from "../src/slice"

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

const droppedToggled = (
  before: string,
  after: string,
  direction: "to-dropped" | "to-kept",
): SymbolChange => ({
  status: "dropped-toggled",
  before: makeSymbol({ id: before, name: before, dropped: direction !== "to-dropped" }),
  after: makeSymbol({
    id: after,
    name: after,
    dropped: direction === "to-dropped",
    fingerprint: direction === "to-dropped" ? zeroFp() : fp(after),
  }),
  direction,
})

function edge(from: string, to: string, line = 1, confidence: Confidence = "high"): CallEdge {
  return { from: symbolId(from), to: symbolId(to), via: "call", confidence, line }
}

describe("computeSlices — Node selection", () => {
  it("two changed symbols connected by an edge form one Slice", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const slices = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A, B] }])
  })

  it("two changed symbols with no edge form two singletons", () => {
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

  it("no bridging through an unchanged Symbol M (A→M→B does NOT unify A,B)", () => {
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

  it("pure moved symbol is NOT a Node and is absent from slices[] entirely", () => {
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

  it("a Symbol changed only in confidence is a Node and clusters with its callee", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const unsure: SymbolChange = {
      status: "changed",
      before: makeSymbol({ id: A, name: A }),
      after: makeSymbol({ id: A, name: A, confidence: "medium" }),
      delta: {
        apiChanged: false,
        logicChanged: false,
        syntaxChanged: false,
        componentChanged: false,
        visibilityChanged: false,
        confidenceChanged: true,
      },
    }
    const slices = computeSlices({
      changes: [unsure, changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B)],
    })
    expect(slices).toEqual([{ id: `slice:${A}`, members: [A, B] }])
  })

  it("propagated-only changed callers (status: changed) are Nodes and cluster with their downstream callee", () => {
    const Ctl = "ts:src/ctl.ts#Ctl.route"
    const Svc = "ts:src/svc.ts#Svc.op"
    const propagatedWrite: Effect = {
      id: "db.write",
      target: "prisma.record.create",
      plugin: "effects-prisma",
      confidence: "high",
      derivedBy: "propagation:svc.op",
      propagated: true,
      derivedFrom: [symbolId(Svc)],
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

describe("computeSlices — Base/head edge union", () => {
  it("{C, oldS(removed), newS(added)} — rename with edge in base only for old, head only for new", () => {
    const C = "ts:src/c.ts#Ctl.route"
    const oldS = "ts:src/svc.ts#Svc.old"
    const newS = "ts:src/svc.ts#Svc.new"
    const slices = computeSlices({
      changes: [changed(C), removed(oldS), added(newS)],
      baseCallEdges: [edge(C, oldS)],
      headCallEdges: [edge(C, newS)],
    })
    expect(slices).toEqual([{ id: `slice:${C}`, members: [C, newS, oldS].sort() }])
  })

  it("a controller relocated to another file reads its base edge under the head id", () => {
    const oldC = "ts:src/ctl.ts#handleRefund"
    const C = "ts:src/controller.ts#handleRefund"
    const oldS = "ts:src/refund.ts#refund"
    const newS = "ts:src/refund2.ts#refundV2"
    const slices = computeSlices({
      changes: [movedChanged(oldC, C), removed(oldS), added(newS)],
      baseCallEdges: [edge(oldC, oldS)],
      headCallEdges: [edge(C, newS)],
    })
    expect(slices).toEqual([{ id: `slice:${C}`, members: [C, oldS, newS].sort() }])
  })

  it("an inlined call keeps its base edge, and a newcomer at the old id stays out", () => {
    const oldC = "ts:src/checkout.ts#submitCheckoutOrder"
    const C = "ts:src/orders/checkout.ts#submitCheckoutOrder"
    const S = "ts:src/helpers.ts#legacyNormalizeAmount"
    const slices = computeSlices({
      changes: [movedChanged(oldC, C), removed(S), added(oldC)],
      baseCallEdges: [edge(oldC, S)],
      headCallEdges: [],
    })
    expect(slices).toEqual([
      { id: `slice:${oldC}`, members: [oldC] },
      { id: `slice:${S}`, members: [S, C].sort() },
    ])
  })

  it("a base edge into a callee under a new id reads the callee under its head id", () => {
    const C = "ts:src/checkout.ts#submitCheckoutOrder"
    const oldS = "ts:src/helpers.ts#normalizeAmount"
    const S = "ts:src/money/helpers.ts#normalizeAmount"
    const slices = computeSlices({
      changes: [changed(C), movedChanged(oldS, S)],
      baseCallEdges: [edge(C, oldS)],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${C}`, members: [C, S].sort() }])
  })

  it("a caller renamed within its own file reads its base edge under the new name", () => {
    const oldC = "ts:src/a.ts#oldName"
    const C = "ts:src/a.ts#newName"
    const S = "ts:src/b.ts#S"
    const slices = computeSlices({
      changes: [movedChanged(oldC, C), removed(S)],
      baseCallEdges: [edge(oldC, S)],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${C}`, members: [C, S] }])
  })

  it("edge only in headCallEdges still unifies its Nodes", () => {
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

  it("edge only in baseCallEdges still unifies its Nodes", () => {
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

describe("computeSlices — Cycles and dropped", () => {
  it("directed cycle A→B→C→A → one Slice with all three, no SCC pre-condense", () => {
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

  it("dropped-toggled Symbol with no in-Node edges becomes a singleton", () => {
    const X = "ts:src/x.ts#X"
    const slices = computeSlices({
      changes: [droppedToggled(X, X, "to-dropped")],
      baseCallEdges: [],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${X}`, members: [X] }])
  })

  it("dropped-toggled Symbol with a kept-side edge to another Node clusters", () => {
    const X = "ts:src/x.ts#X"
    const K = "ts:src/k.ts#K"
    const slices = computeSlices({
      changes: [droppedToggled(X, X, "to-dropped"), changed(K)],
      baseCallEdges: [edge(X, K)], // kept-side (base) edge from X to a still-changed Symbol
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${K}`, members: [K, X] }])
  })

  it("a dropped-toggled Symbol under a new id clusters under its head id", () => {
    const oldX = "ts:src/x.ts#X"
    const X = "ts:src/y.ts#X"
    const K = "ts:src/k.ts#K"
    const slices = computeSlices({
      changes: [droppedToggled(oldX, X, "to-dropped"), changed(K)],
      baseCallEdges: [edge(oldX, K)],
      headCallEdges: [],
    })
    expect(slices).toEqual([{ id: `slice:${K}`, members: [K, X] }])
  })
})

describe("computeSlices — Cluster identity and ordering", () => {
  it("sliceId = 'slice:' + smallest member id (verbatim, no sanitisation)", () => {
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

  it("slices[] is sorted by ascending anchor id", () => {
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

  it("members[] within a Slice is sorted ascending", () => {
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

describe("computeSlices — Determinism", () => {
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

  it("idempotence — two runs produce byte-identical JSON", () => {
    const { changes, edges } = buildInputs()
    const one = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const two = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
  })

  it("input-order insensitivity — shuffled inputs produce identical output", () => {
    const { changes, edges } = buildInputs()
    const canonical = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const shuffled = computeSlices({
      changes: [...changes].reverse(),
      baseCallEdges: [...edges].reverse().map((e) => ({ ...e, from: e.to, to: e.from })),
      headCallEdges: [],
    })
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical))
  })

  it("locality — adding an unchanged Symbol elsewhere does not change any slice", () => {
    const { changes, edges } = buildInputs()
    const before = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    const after = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })
    expect(after).toEqual(before)
  })

  it("adding a new Node in a disjoint component leaves existing slices unchanged", () => {
    const { A, B, C, D, changes, edges } = buildInputs()
    const before = computeSlices({ changes, baseCallEdges: [], headCallEdges: edges })

    const Z = "ts:src/z.ts#Z"
    const after = computeSlices({
      changes: [...changes, changed(Z)],
      baseCallEdges: [],
      headCallEdges: edges,
    })
    expect(after.find((s) => s.id === `slice:${A}`)?.members).toEqual([A, B])
    expect(after.find((s) => s.id === `slice:${C}`)?.members).toEqual([C, D])
    expect(after.find((s) => s.id === `slice:${Z}`)?.members).toEqual([Z])
    expect(after).toHaveLength(before.length + 1)
  })
})

describe("computeSlices — Zero-Node and edge shape edge cases", () => {
  it("a Node-less change set yields slices: []", () => {
    // Only pure `moved` — not a Node.
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

describe("computeSlices — cross-language partition", () => {
  it("partitions Nodes by language when the changes span multiple languages", () => {
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

describe("computeSlices — anchor derivation invariant", () => {
  /** Assert the non-throwing and the throwing form agree on which clause broke. */
  function expectViolation(record: unknown, kind: SliceViolationKind, subject: string): void {
    const violation = sliceRecordViolation(record)
    expect(violation?.kind).toBe(kind)
    expect(violation?.subject).toBe(subject)

    if (violation?.kind === "malformed-shape") return
    expect(() => assertSliceRecordInvariant(record as SliceRecord)).toThrow(DiffError)
    try {
      assertSliceRecordInvariant(record as SliceRecord)
    } catch (e) {
      expect(e).toBeInstanceOf(DiffError)
      if (e instanceof DiffError) {
        expect(e.code).toBe("slice-invariant-violated")
        expect(e.value).toBe(subject)
        expect(e.message).toBe(violation?.message)
      }
    }
  }

  it("every SliceRecord the pass emits satisfies the invariant", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const C = "ts:src/c.ts#C"
    const Z = "ts:src/z.ts#Z"
    const slices = computeSlices({
      changes: [droppedToggled(Z, Z, "to-dropped"), removed(C), added(B), changed(A)],
      baseCallEdges: [edge(C, A)],
      headCallEdges: [edge(A, B)],
    })
    expect(slices.length).toBeGreaterThan(1)
    for (const slice of slices) {
      expect(sliceRecordViolation(slice)).toBeNull()
      expect(() => assertSliceRecordInvariant(slice)).not.toThrow()
      expect(slice.id).toBe(`slice:${slice.members[0]}`)
      for (let i = 1; i < slice.members.length; i++) {
        // Strictly ascending — `[...members].sort()` would also accept duplicates.
        expect((slice.members[i - 1] as string) < (slice.members[i] as string)).toBe(true)
      }
    }
  })

  it("sliceAnchor returns members[0] without deriving it from the id", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const [slice] = computeSlices({
      changes: [changed(A), changed(B)],
      baseCallEdges: [],
      headCallEdges: [edge(A, B)],
    })
    if (slice === undefined) throw new Error("unreachable: one Slice expected")
    expect(sliceAnchor(slice)).toBe(A)

    expect(sliceAnchor({ id: sliceId(`slice:${B}`), members: [symbolId(A), symbolId(B)] })).toBe(A)
  })

  it("rejects a correct `slice:` prefix whose id is not the anchor", () => {
    expectViolation(
      { id: "slice:ts:src/foo.ts#foo", members: ["ts:src/bar.ts#bar", "ts:src/baz.ts#baz"] },
      "id-not-derived",
      "slice:ts:src/foo.ts#foo",
    )
  })

  it("rejects members[] that are not in strictly ascending order", () => {
    expectViolation(
      { id: "slice:ts:src/b.ts#B", members: ["ts:src/b.ts#B", "ts:src/a.ts#A"] },
      "members-unordered",
      "slice:ts:src/b.ts#B",
    )
  })

  it("rejects duplicated members (a non-strict ascending run)", () => {
    expectViolation(
      { id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A", "ts:src/a.ts#A"] },
      "members-unordered",
      "slice:ts:src/a.ts#A",
    )
  })

  it("rejects an empty members[]", () => {
    expectViolation(
      { id: "slice:ts:src/a.ts#A", members: [] },
      "members-empty",
      "slice:ts:src/a.ts#A",
    )
  })

  it("rejects a missing `slice:` prefix through the same derivation check", () => {
    expectViolation(
      { id: "ts:src/a.ts#A", members: ["ts:src/a.ts#A"] },
      "id-not-derived",
      "ts:src/a.ts#A",
    )
  })

  it("sliceAnchor throws rather than returning undefined for an empty members[]", () => {
    expect(() => sliceAnchor({ id: sliceId("slice:ts:src/a.ts#A"), members: [] })).toThrow(
      DiffError,
    )
  })
})

describe("sliceRecordViolation — untyped input", () => {
  it("reports a missing members[] instead of throwing", () => {
    const violation = sliceRecordViolation({ id: "slice:ts:src/a.ts#A" })
    expect(violation?.kind).toBe("malformed-shape")
    expect(violation?.subject).toBe("slice:ts:src/a.ts#A")
  })

  it("reports a members[] that is not an array instead of scanning its characters", () => {
    const violation = sliceRecordViolation({ id: "slice:ts:src/a.ts#A", members: "nope" })
    expect(violation?.kind).toBe("malformed-shape")
    expect(violation?.message).toMatch(/array of strings/)
  })

  it("reports a members[] holding non-strings", () => {
    expect(sliceRecordViolation({ id: "slice:a", members: ["a", 7] })?.kind).toBe("malformed-shape")
    expect(sliceRecordViolation({ id: "slice:a", members: 5 })?.kind).toBe("malformed-shape")
  })

  it("reports a missing or non-string id instead of stringifying `undefined` into the message", () => {
    const violation = sliceRecordViolation({ members: ["ts:src/a.ts#A"] })
    expect(violation?.kind).toBe("malformed-shape")
    expect(violation?.subject).toBe("<missing id>")
    expect(violation?.message).not.toMatch(/"undefined"/)
  })

  it("reports non-objects", () => {
    for (const value of [null, undefined, 42, "slice:a", []]) {
      expect(sliceRecordViolation(value)?.kind).toBe("malformed-shape")
    }
  })
})

describe("a Slice id cannot be built on an anchor from a reserved namespace", () => {
  it("rejects an anchor in the `slice:` namespace even though the derivation is self-consistent", () => {
    const violation = sliceRecordViolation({
      id: "slice:slice:src/a.ts#A",
      members: ["slice:src/a.ts#A"],
    })
    expect(violation?.kind).toBe("anchor-in-reserved-namespace")
    expect(violation?.message).toContain("slice")
  })

  it("leaves an anchor whose language token merely starts with the reserved one alone", () => {
    expect(
      sliceRecordViolation({ id: "slice:slicer:src/a.ts#A", members: ["slicer:src/a.ts#A"] }),
    ).toBeNull()
  })
})
