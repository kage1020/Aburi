import { makeIR, makeSymbol } from "@aburi/test-support"
import type { Dependency, IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, type DependencySideView, diffDependencies, renameDirections } from "../src"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

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
    const skipped = [{ path: "src/gone.ts", reason: "over-size" as const }]
    const base = withSkipped(makeIR({ symbols: [kept] }), skipped)
    const head = withSkipped(makeIR({ symbols: [kept] }), skipped)
    const result = diffOf(base, head)

    expect(result.dependencies.unknown).toEqual([])
    expect(result.summary.depsUnknown).toBe(0)
  })

  it("keeps a direction flip as an added + removed pair", () => {
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
    const blind: DependencySideView = { symbolFiles: new Map(), lostFiles: new Map() }
    const result = diffDependencies(
      [dep("ts:src/gone.ts#gone", "ts:src/kept.ts#kept")],
      [dep("billing", "pricing", { via: "import" })],
      { base: blind, head: blind, renames: renameDirections(null) },
    )
    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.unknown).toEqual([])
  })
})
