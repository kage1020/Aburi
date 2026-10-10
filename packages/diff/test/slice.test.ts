import type { CallEdge } from "@aburi/core"
import { fp, makeSymbol, symbolId, zeroFp } from "@aburi/test-support"
import type { SymbolChange, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSlices } from "../src"

const LOGIC_ONLY: SymbolDelta = {
  apiChanged: false,
  logicChanged: true,
  syntaxChanged: false,
  componentChanged: false,
  visibilityChanged: false,
}

const changed = (id: string): SymbolChange => ({
  status: "changed",
  before: makeSymbol({ id, name: id }),
  after: makeSymbol({ id, name: id, fingerprint: fp(id) }),
  delta: LOGIC_ONLY,
})

const added = (id: string): SymbolChange => ({
  status: "added",
  symbol: makeSymbol({ id, name: id }),
})

const removed = (id: string): SymbolChange => ({
  status: "removed",
  symbol: makeSymbol({ id, name: id }),
})

const unknown = (id: string): SymbolChange => ({
  status: "unknown",
  symbol: makeSymbol({ id, name: id }),
  absentFrom: "head",
  reason: "parse-failed",
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
  delta: LOGIC_ONLY,
})

const toDropped = (before: string, after: string): SymbolChange => ({
  status: "dropped-toggled",
  before: makeSymbol({ id: before, name: before }),
  after: makeSymbol({ id: after, name: after, dropped: true, fingerprint: zeroFp() }),
  direction: "to-dropped",
})

function edge(from: string, to: string, line = 1): CallEdge {
  return { from: symbolId(from), to: symbolId(to), via: "call", confidence: "high", line }
}

function slicesOf(
  changes: SymbolChange[],
  baseCallEdges: CallEdge[] = [],
  headCallEdges: CallEdge[] = [],
) {
  return computeSlices({ changes, baseCallEdges, headCallEdges })
}

const A = "ts:src/a.ts#A"
const B = "ts:src/b.ts#B"
const C = "ts:src/c.ts#C"
const D = "ts:src/d.ts#D"

describe("which changes are Slice Nodes", () => {
  it.each([
    ["a changed Symbol", changed(A), A],
    ["an added Symbol", added(A), A],
    ["a removed Symbol", removed(A), A],
    ["an unknown Symbol", unknown(A), A],
    ["a moved+changed Symbol, under its head id", movedChanged("ts:src/old.ts#A", A), A],
    ["a dropped-toggled Symbol, under its head id", toDropped("ts:src/old.ts#A", A), A],
  ])("makes %s a Node", (_, change, nodeId) => {
    expect(slicesOf([change])).toEqual([{ id: `slice:${nodeId}`, members: [nodeId] }])
  })

  it("leaves a pure move out of slices[] entirely, even with edges into it", () => {
    const oldId = "ts:src/old.ts#moved"
    const newId = "ts:src/new.ts#moved"
    expect(
      slicesOf([changed(A), moved(oldId, newId)], [], [edge(A, newId), edge(A, oldId)]),
    ).toEqual([{ id: `slice:${A}`, members: [A] }])
  })

  it("yields no Slice when no change is a Node", () => {
    expect(slicesOf([moved("ts:src/a.ts#a", "ts:src/b.ts#a")])).toEqual([])
  })
})

describe("which edges join Nodes into one Slice", () => {
  it("joins two Nodes a head edge connects", () => {
    expect(slicesOf([changed(A), changed(B)], [], [edge(A, B)])).toEqual([
      { id: `slice:${A}`, members: [A, B] },
    ])
  })

  it("keeps two unconnected Nodes in Slices of their own", () => {
    expect(slicesOf([changed(A), changed(B)])).toEqual([
      { id: `slice:${A}`, members: [A] },
      { id: `slice:${B}`, members: [B] },
    ])
  })

  it("does not bridge two Nodes through an unchanged Symbol between them", () => {
    const M = "ts:src/mid.ts#M"
    expect(slicesOf([changed(A), changed(B)], [], [edge(A, M), edge(M, B)])).toEqual([
      { id: `slice:${A}`, members: [A] },
      { id: `slice:${B}`, members: [B] },
    ])
  })

  it("drops an edge whose other end is not a Node, and a self-loop", () => {
    const External = "ts:src/ext.ts#external"
    expect(
      slicesOf([changed(A)], [edge(A, A)], [edge(A, External), edge(External, A), edge(A, A)]),
    ).toEqual([{ id: `slice:${A}`, members: [A] }])
  })

  it("collapses repeated edges between one pair into one connection", () => {
    expect(
      slicesOf(
        [changed(A), changed(B)],
        [edge(A, B, 1), edge(A, B, 2)],
        [edge(A, B, 3), edge(B, A, 4)],
      ),
    ).toEqual([{ id: `slice:${A}`, members: [A, B] }])
  })

  it("joins a directed cycle into one Slice", () => {
    expect(
      slicesOf([changed(A), changed(B), changed(C)], [], [edge(A, B), edge(B, C), edge(C, A)]),
    ).toEqual([{ id: `slice:${A}`, members: [A, B, C] }])
  })

  it("joins a caller to the old callee through a base edge and the new one through a head edge", () => {
    const ctl = "ts:src/c.ts#Ctl.route"
    const oldSvc = "ts:src/svc.ts#Svc.old"
    const newSvc = "ts:src/svc.ts#Svc.new"
    expect(
      slicesOf(
        [changed(ctl), removed(oldSvc), added(newSvc)],
        [edge(ctl, oldSvc)],
        [edge(ctl, newSvc)],
      ),
    ).toEqual([{ id: `slice:${ctl}`, members: [ctl, newSvc, oldSvc] }])
  })

  it("does not split Slices by language", () => {
    const tsA = "ts:src/a.ts#a"
    const pyB = "py:app/b.py#b"
    expect(slicesOf([changed(tsA), changed(pyB)], [], [edge(tsA, pyB)])).toEqual([
      { id: `slice:${pyB}`, members: [pyB, tsA] },
    ])
  })
})

describe("a base edge into a Symbol that changed id", () => {
  it("reads a relocated caller under its head id", () => {
    const oldCtl = "ts:src/ctl.ts#handleRefund"
    const ctl = "ts:src/controller.ts#handleRefund"
    const oldSvc = "ts:src/refund.ts#refund"
    const newSvc = "ts:src/refund2.ts#refundV2"
    expect(
      slicesOf(
        [movedChanged(oldCtl, ctl), removed(oldSvc), added(newSvc)],
        [edge(oldCtl, oldSvc)],
        [edge(ctl, newSvc)],
      ),
    ).toEqual([{ id: `slice:${ctl}`, members: [ctl, oldSvc, newSvc].sort() }])
  })

  it("reads a callee under a new id under its head id", () => {
    const ctl = "ts:src/checkout.ts#submitCheckoutOrder"
    const oldSvc = "ts:src/helpers.ts#normalizeAmount"
    const svc = "ts:src/money/helpers.ts#normalizeAmount"
    expect(slicesOf([changed(ctl), movedChanged(oldSvc, svc)], [edge(ctl, oldSvc)])).toEqual([
      { id: `slice:${ctl}`, members: [ctl, svc].sort() },
    ])
  })

  it("reads a caller renamed within its own file under its new name", () => {
    const oldCtl = "ts:src/a.ts#oldName"
    const ctl = "ts:src/a.ts#newName"
    const svc = "ts:src/b.ts#S"
    expect(slicesOf([movedChanged(oldCtl, ctl), removed(svc)], [edge(oldCtl, svc)])).toEqual([
      { id: `slice:${ctl}`, members: [ctl, svc] },
    ])
  })

  it("reads a dropped-toggled Symbol under its head id", () => {
    const oldX = "ts:src/x.ts#X"
    const X = "ts:src/y.ts#X"
    const K = "ts:src/k.ts#K"
    expect(slicesOf([toDropped(oldX, X), changed(K)], [edge(oldX, K)])).toEqual([
      { id: `slice:${K}`, members: [K, X] },
    ])
  })

  it("keeps the pair's edge when a newcomer takes the old id, and leaves the newcomer out", () => {
    const oldCtl = "ts:src/checkout.ts#submitCheckoutOrder"
    const ctl = "ts:src/orders/checkout.ts#submitCheckoutOrder"
    const helper = "ts:src/helpers.ts#legacyNormalizeAmount"
    expect(
      slicesOf([movedChanged(oldCtl, ctl), removed(helper), added(oldCtl)], [edge(oldCtl, helper)]),
    ).toEqual([
      { id: `slice:${oldCtl}`, members: [oldCtl] },
      { id: `slice:${helper}`, members: [helper, ctl].sort() },
    ])
  })
})

describe("Slice identity and order", () => {
  it("names a Slice after its smallest member, verbatim", () => {
    const X = "ts:src/a.ts#X"
    const Y = "ts:src/a.ts#Y"
    const Z = "ts:src/a.ts#Z"
    expect(slicesOf([changed(Z), changed(Y), changed(X)], [], [edge(Y, Z), edge(X, Y)])).toEqual([
      { id: `slice:${X}`, members: [X, Y, Z] },
    ])
  })

  it("sorts slices[] by anchor and each members[] ascending", () => {
    const M = "ts:src/m.ts#M"
    const X = "ts:src/x.ts#X"
    expect(
      slicesOf([changed(M), changed(X), changed(B), changed(A)], [], [edge(X, M), edge(B, A)]),
    ).toEqual([
      { id: `slice:${A}`, members: [A, B] },
      { id: `slice:${M}`, members: [M, X] },
    ])
  })

  it("answers the same however its inputs are ordered or edges are directed", () => {
    const changes = [changed(A), changed(B), changed(C), changed(D)]
    const edges = [edge(A, B), edge(C, D)]
    expect(
      slicesOf(
        [...changes].reverse(),
        [...edges].reverse().map((e) => ({ ...e, from: e.to, to: e.from })),
      ),
    ).toEqual(slicesOf(changes, [], edges))
  })

  it("leaves existing Slices alone when a Node joins in a disjoint component", () => {
    const changes = [changed(A), changed(B), changed(C), changed(D)]
    const edges = [edge(A, B), edge(C, D)]
    const Z = "ts:src/z.ts#Z"
    expect(slicesOf([...changes, changed(Z)], [], edges)).toEqual([
      ...slicesOf(changes, [], edges),
      { id: `slice:${Z}`, members: [Z] },
    ])
  })
})
