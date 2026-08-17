import type { Dependency, IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, diffDependencies } from "../src"
import { makeIR, makeSymbol } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

/**
 * A dependency whose endpoint file the other side never analysed is not a deletion.
 *
 * `SymbolChange.status: "unknown"` stopped `aburi diff` reporting a withdrawn file's Symbols as
 * deleted API. `dependencies[]` is projected from the resolved call graph, so the same withdrawn
 * file takes every edge it participated in with it — including edges whose *other* end survived
 * — and `summary.depsRemoved` was reporting exactly the same confident deletion one array over.
 */

function dep(from: string, to: string, over: Partial<Dependency> = {}): Dependency {
  return { from, to, via: "call", direction: "outbound", effect: null, ...over } as Dependency
}

function withSkipped(ir: IR, skipped: readonly SkippedFile[], totalFiles = 3): IR {
  return {
    ...ir,
    stats: {
      ...ir.stats,
      totalFiles,
      parsedFiles: totalFiles - skipped.length,
      skippedFiles: [...skipped],
    },
  }
}

const gone = makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })
const goneToo = makeSymbol({ id: "ts:src/gone.ts#goneToo", name: "goneToo" })
const alsoGone = makeSymbol({ id: "ts:src/also.ts#alsoGone", name: "alsoGone" })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

function diffOf(baseIR: IR, headIR: IR) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF })
}

describe("buildDiff — an edge into a file the other side never analysed", () => {
  it("is unknown, not removed, when the lost endpoint is the source", () => {
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
    })
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(0)
    expect(result.summary.depsUnknown).toBe(1)
    expect(result.dependencies.removed).toEqual([])
    expect(result.dependencies.unknown).toEqual([
      {
        dependency: dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
        absentFrom: "head",
        lostFiles: [{ path: "src/gone.ts", reason: "parse-failed" }],
      },
    ])
  })

  it("is unknown when only the target was lost and the source survived", () => {
    // The half that is easiest to miss: `kept` is in both documents, so the edge looks like a
    // call the author deleted. It disappeared because the callee's file was never read.
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/kept.ts#kept", "ts:src/gone.ts#gone")],
    })
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/gone.ts", reason: "over-size" },
    ])
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(0)
    expect(result.dependencies.unknown?.[0]?.lostFiles).toEqual([
      { path: "src/gone.ts", reason: "over-size" },
    ])
  })

  it("is unknown, not added, when base is the side that lost the file", () => {
    const base = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/gone.ts", reason: "parse-timeout" },
    ])
    const head = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
    })
    const result = diffOf(base, head)

    expect(result.summary.depsAdded).toBe(0)
    expect(result.summary.depsUnknown).toBe(1)
    expect(result.dependencies.unknown?.[0]?.absentFrom).toBe("base")
  })

  it("collapses an intra-file edge to the one file it lost", () => {
    const base = makeIR({
      symbols: [gone, goneToo, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/gone.ts#goneToo")],
    })
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
    expect(diffOf(base, head).dependencies.unknown?.[0]?.lostFiles).toEqual([
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
  })

  it("names both files, path-sorted, when the two endpoints went for different reasons", () => {
    // One `reason` the way `SymbolUnknown` carries it cannot describe this edge: the reader
    // has to re-run for one end and fix something for the other.
    const base = makeIR({
      symbols: [gone, alsoGone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/also.ts#alsoGone")],
    })
    const head = withSkipped(
      makeIR({ symbols: [kept] }),
      [
        { path: "src/also.ts", reason: "parse-timeout" },
        { path: "src/gone.ts", reason: "extraction-failed" },
      ],
      4,
    )
    expect(diffOf(base, head).dependencies.unknown?.[0]?.lostFiles).toEqual([
      { path: "src/also.ts", reason: "parse-timeout" },
      { path: "src/gone.ts", reason: "extraction-failed" },
    ])
  })

  it("leaves a component-level edge alone, because a Component has no file to lose", () => {
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [
        dep("billing", "pricing", { via: "import" }),
        dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
      ],
    })
    const head = withSkipped(makeIR({ symbols: [kept], dependencies: [] }), [
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
    const result = diffOf(base, head)

    expect(result.dependencies.removed).toEqual([dep("billing", "pricing", { via: "import" })])
    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(1)
  })

  it("leaves an edge whose file nobody lost as a removal", () => {
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/kept.ts#kept", "ts:src/gone.ts#gone")],
    })
    const head = makeIR({ symbols: [gone, kept] })
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(0)
  })

  it("says nothing about a file both sides lost, because neither holds the edge", () => {
    // The deps-side face of the gap `aburi diff` warns about on stderr: with no Symbols from
    // the file in either document there is no edge to classify, so the diff is silent about a
    // dependency it never compared.
    const skipped = [{ path: "src/gone.ts", reason: "over-size" as const }]
    const base = withSkipped(makeIR({ symbols: [kept] }), skipped)
    const head = withSkipped(makeIR({ symbols: [kept] }), skipped)
    const result = diffOf(base, head)

    expect(result.dependencies.unknown).toEqual([])
    expect(result.summary.depsUnknown).toBe(0)
  })

  it("keeps a direction flip as an added + removed pair", () => {
    // Both documents hold the triple, so neither lost an endpoint file and the pair is a real
    // change. The membership check is what separates the two: a flipped key is on both sides.
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
    })
    const head = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept", { direction: "inbound" })],
    })
    const result = diffOf(base, head)

    expect(result.summary.depsAdded).toBe(1)
    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(0)
    expect(result.dependencies.unknown).toEqual([])
  })

  it("writes the array and the counter even when nothing was unknown", () => {
    // "Nothing was unknown" and "this writer could not say" are different answers, and unlike
    // the IR's skippedFiles there is no arithmetic in the document to tell them apart.
    const result = diffOf(makeIR({ symbols: [kept] }), makeIR({ symbols: [kept] }))
    expect(result.dependencies.unknown).toEqual([])
    expect(result.summary.depsUnknown).toBe(0)
  })

  it("sorts the unknown edges by the same key as added and removed", () => {
    const base = makeIR({
      symbols: [gone, goneToo, alsoGone, kept],
      dependencies: [
        dep("ts:src/kept.ts#kept", "ts:src/gone.ts#goneToo"),
        dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
        dep("ts:src/also.ts#alsoGone", "ts:src/kept.ts#kept"),
      ],
    })
    const head = withSkipped(
      makeIR({ symbols: [kept] }),
      [
        { path: "src/also.ts", reason: "parse-failed" },
        { path: "src/gone.ts", reason: "parse-failed" },
      ],
      4,
    )
    const keys = diffOf(base, head).dependencies.unknown?.map(
      (u) => `${u.dependency.from}::${u.dependency.to}::${u.dependency.via}`,
    )
    expect(keys).toEqual([...(keys ?? [])].sort())
    expect(keys).toHaveLength(3)
  })
})

describe("diffDependencies — called without the side views", () => {
  it("classifies every one-sided edge as before, and emits an empty unknown array", () => {
    // The parameter is optional so a direct caller keeps the behaviour it had; `buildDiff` is
    // the one that always supplies it.
    const result = diffDependencies(
      [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
      [dep("billing", "pricing", { via: "import" })],
    )
    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.unknown).toEqual([])
  })
})
