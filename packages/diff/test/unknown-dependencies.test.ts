import type { Dependency, IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, type DependencySideView, diffDependencies } from "../src"
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
const relocated = makeSymbol({
  id: "ts:src/old.ts#relocated",
  name: "relocated",
  source: {
    file: "src/actual.ts",
    startLine: 1,
    endLine: 10,
    startColumn: null,
    endColumn: null,
  },
})

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
    // `billing` is also the path of a file this scan skipped — the one arrangement that tells
    // "endpoints are resolved through symbols[].source.file" apart from "the endpoint string is
    // matched against skippedFiles". A Component id is not a path, and treating it as one would
    // make an architectural edge disappear into the unknown group on a coincidence.
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [
        dep("billing", "pricing", { via: "import" }),
        dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
      ],
    })
    const head = withSkipped(
      makeIR({ symbols: [kept], dependencies: [] }),
      [
        { path: "billing", reason: "unroutable" },
        { path: "src/gone.ts", reason: "parse-failed" },
      ],
      4,
    )
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

  it("asks the document where the Symbol says it is, not where its id says", () => {
    // The decision this whole classification rests on. `makeSymbol` defaults `source.file` to
    // the id's path segment, so on every other fixture in this file the two are equal and an
    // implementation that parsed the id would pass identically. Here they disagree: the id says
    // `src/old.ts`, the Symbol says `src/actual.ts`. A re-export or a generated file is exactly
    // where the two come apart in a real workspace.
    const base = makeIR({
      symbols: [relocated, kept],
      dependencies: [dep("ts:src/old.ts#relocated", "ts:src/kept.ts#kept")],
    })
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/actual.ts", reason: "parse-failed" },
    ])
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(0)
    expect(result.dependencies.unknown).toEqual([
      {
        dependency: dep("ts:src/old.ts#relocated", "ts:src/kept.ts#kept"),
        absentFrom: "head",
        lostFiles: [{ path: "src/actual.ts", reason: "parse-failed" }],
      },
    ])
  })

  it("is a removal when only the path inside the id was skipped", () => {
    // The other half, and the one that fails under an id-parsing implementation: `src/old.ts`
    // is a path no Symbol in this document lives in, so the head skipping it says nothing about
    // this edge. Reading the file out of the id would call it unknown and hide a real deletion.
    const base = makeIR({
      symbols: [relocated, kept],
      dependencies: [dep("ts:src/old.ts#relocated", "ts:src/kept.ts#kept")],
    })
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/old.ts", reason: "parse-failed" },
    ])
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(0)
    expect(result.dependencies.unknown).toEqual([])
  })

  it("keeps both files when two endpoints went for the same reason", () => {
    // Deduping by reason instead of by path would collapse these two into one and satisfy
    // `minItems: 1` while losing a file — invisible on the differing-reasons case above.
    const base = makeIR({
      symbols: [gone, alsoGone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/also.ts#alsoGone")],
    })
    const head = withSkipped(
      makeIR({ symbols: [kept] }),
      [
        { path: "src/also.ts", reason: "parse-failed" },
        { path: "src/gone.ts", reason: "parse-failed" },
      ],
      4,
    )
    expect(diffOf(base, head).dependencies.unknown?.[0]?.lostFiles).toEqual([
      { path: "src/also.ts", reason: "parse-failed" },
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
  })

  it("ignores a file the document holding the edge skipped itself", () => {
    // Self-loss is not an explanation for anything: this document has the edge, so whatever it
    // skipped did not stop it from producing one. The absence being explained is the *other*
    // document's, and only its skip list can explain it. Deliberate, and unpinned until here —
    // widening the check to the holder's own list passes every other test in this file.
    const base = withSkipped(
      makeIR({
        symbols: [gone, kept],
        dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
      }),
      [{ path: "src/gone.ts", reason: "over-size" }],
    )
    const head = makeIR({ symbols: [gone, kept] })
    const result = diffOf(base, head)

    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(0)
  })

  it("counts the three kinds apart, and puts each edge in exactly one array", () => {
    // The exclusion the schema states — `depsAdded` and `depsRemoved` exclude the unknown ones
    // — asserted with all three non-zero at once. Pairwise assertions cannot see a double-count.
    const base = makeIR({
      symbols: [gone, kept],
      dependencies: [
        dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
        dep("billing", "legacy", { via: "import" }),
      ],
    })
    const head = withSkipped(
      makeIR({
        symbols: [kept],
        dependencies: [dep("billing", "payments", { via: "import" })],
      }),
      [{ path: "src/gone.ts", reason: "parse-failed" }],
    )
    const result = diffOf(base, head)

    expect(result.summary.depsAdded).toBe(1)
    expect(result.summary.depsRemoved).toBe(1)
    expect(result.summary.depsUnknown).toBe(1)
    const unknownEdge = result.dependencies.unknown?.[0]?.dependency
    expect(unknownEdge).toEqual(dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"))
    expect(result.dependencies.added).toEqual([dep("billing", "payments", { via: "import" })])
    expect(result.dependencies.removed).toEqual([dep("billing", "legacy", { via: "import" })])
  })

  it("carries the lost files on a base-side loss too, not just the side", () => {
    const base = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/gone.ts", reason: "unreadable" },
    ])
    const head = makeIR({
      symbols: [gone, kept],
      dependencies: [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
    })
    expect(diffOf(base, head).dependencies.unknown).toEqual([
      {
        dependency: dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept"),
        absentFrom: "base",
        lostFiles: [{ path: "src/gone.ts", reason: "unreadable" }],
      },
    ])
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

describe("diffDependencies — a side view with nothing to say", () => {
  it("classifies every one-sided edge as before, and still writes the unknown array", () => {
    // The honest spelling of "I have no skip list": an IR predating `stats.skippedFiles` is
    // exactly this, and §3.5.1 already describes what a diff against one may and may not
    // conclude. It has to be written rather than defaulted into, because `unknown: []` in the
    // artifact means "nothing was unknown" and not "nobody looked".
    const blind: DependencySideView = { symbolFiles: new Map(), lostFiles: new Map() }
    const result = diffDependencies(
      [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
      [dep("billing", "pricing", { via: "import" })],
      { base: blind, head: blind },
    )
    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.unknown).toEqual([])
  })
})
