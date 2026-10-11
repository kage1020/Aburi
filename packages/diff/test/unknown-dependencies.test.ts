import { dependency, makeIR, makeSymbol } from "@aburi/test-support"
import type { Dependency, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type DependencySideView, diffDependencies, renameDirections } from "../src"
import { diffOf, withSkipped } from "./helpers"

const call = (from: string, to: string, overrides: Partial<Dependency> = {}) =>
  dependency({ from, to, via: "call", ...overrides })
const imports = (from: string, to: string) => dependency({ from, to, via: "import" })
const lost = (path: string, reason: SkippedFile["reason"] = "parse-failed"): SkippedFile => ({
  path,
  reason,
})

const gone = makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })
const goneToo = makeSymbol({ id: "ts:src/gone.ts#goneToo", name: "goneToo" })
const alsoGone = makeSymbol({ id: "ts:src/also.ts#alsoGone", name: "alsoGone" })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
const relocated = makeSymbol({
  id: "ts:src/old.ts#relocated",
  name: "relocated",
  source: { file: "src/actual.ts", startLine: 1, endLine: 10, startColumn: null, endColumn: null },
})

const GONE_TO_KEPT = call(gone.id, kept.id)

describe("an edge into a file the other side never analysed", () => {
  it("is unknown, not removed, when head lost its source's file", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept], dependencies: [GONE_TO_KEPT] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")]),
    )
    expect(diff.summary).toMatchObject({ depsRemoved: 0, depsUnknown: 1 })
    expect(diff.dependencies.removed).toEqual([])
    expect(diff.dependencies.unknown).toEqual([
      { dependency: GONE_TO_KEPT, absentFrom: "head", lostFiles: [lost("src/gone.ts")] },
    ])
  })

  it("is unknown when only its target's file was lost", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept], dependencies: [call(kept.id, gone.id)] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts", "over-size")]),
    )
    expect(diff.summary.depsRemoved).toBe(0)
    expect(diff.dependencies.unknown?.[0]?.lostFiles).toEqual([lost("src/gone.ts", "over-size")])
  })

  it("is unknown, not added, when base lost the file", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts", "unreadable")]),
      makeIR({ symbols: [gone, kept], dependencies: [GONE_TO_KEPT] }),
    )
    expect(diff.summary).toMatchObject({ depsAdded: 0, depsUnknown: 1 })
    expect(diff.dependencies.unknown).toEqual([
      {
        dependency: GONE_TO_KEPT,
        absentFrom: "base",
        lostFiles: [lost("src/gone.ts", "unreadable")],
      },
    ])
  })

  it("names the one file an intra-file edge lost", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, goneToo, kept], dependencies: [call(gone.id, goneToo.id)] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")]),
    )
    expect(diff.dependencies.unknown?.[0]?.lostFiles).toEqual([lost("src/gone.ts")])
  })

  it.each([
    ["different reasons", "parse-timeout", "extraction-failed"],
    ["the same reason", "parse-failed", "parse-failed"],
  ] as const)("names both files, path-sorted, when its two ends went for %s", (_, alsoReason, goneReason) => {
    const diff = diffOf(
      makeIR({ symbols: [gone, alsoGone, kept], dependencies: [call(gone.id, alsoGone.id)] }),
      withSkipped(makeIR({ symbols: [kept] }), [
        lost("src/also.ts", alsoReason),
        lost("src/gone.ts", goneReason),
      ]),
    )
    expect(diff.dependencies.unknown?.[0]?.lostFiles).toEqual([
      lost("src/also.ts", alsoReason),
      lost("src/gone.ts", goneReason),
    ])
  })

  it("asks the document where the Symbol says it is, not where its id says", () => {
    const edge = call(relocated.id, kept.id)
    const diff = diffOf(
      makeIR({ symbols: [relocated, kept], dependencies: [edge] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/actual.ts")]),
    )
    expect(diff.summary.depsRemoved).toBe(0)
    expect(diff.dependencies.unknown).toEqual([
      { dependency: edge, absentFrom: "head", lostFiles: [lost("src/actual.ts")] },
    ])
  })

  it("is sorted with the others by the same key as added and removed", () => {
    const edges = [call(kept.id, goneToo.id), call(gone.id, kept.id), call(alsoGone.id, kept.id)]
    const diff = diffOf(
      makeIR({ symbols: [gone, goneToo, alsoGone, kept], dependencies: edges }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/also.ts"), lost("src/gone.ts")]),
    )
    expect(diff.dependencies.unknown?.map((entry) => entry.dependency)).toEqual([
      edges[2],
      edges[1],
      edges[0],
    ])
  })
})

describe("an edge that is not unknown although a file was lost", () => {
  it("is removed when only the path inside its endpoint's id was skipped", () => {
    const diff = diffOf(
      makeIR({ symbols: [relocated, kept], dependencies: [call(relocated.id, kept.id)] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/old.ts")]),
    )
    expect(diff.summary).toMatchObject({ depsRemoved: 1, depsUnknown: 0 })
  })

  it("is removed when it runs between Components, which have no file to lose", () => {
    const diff = diffOf(
      makeIR({
        symbols: [gone, kept],
        dependencies: [imports("billing", "pricing"), GONE_TO_KEPT],
      }),
      withSkipped(makeIR({ symbols: [kept] }), [
        lost("billing", "unroutable"),
        lost("src/gone.ts"),
      ]),
    )
    expect(diff.dependencies.removed).toEqual([imports("billing", "pricing")])
    expect(diff.summary).toMatchObject({ depsRemoved: 1, depsUnknown: 1 })
  })

  it("is removed when nobody lost its file", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept], dependencies: [call(kept.id, gone.id)] }),
      makeIR({ symbols: [gone, kept] }),
    )
    expect(diff.summary).toMatchObject({ depsRemoved: 1, depsUnknown: 0 })
  })

  it("is removed when the file was lost by the document that holds the edge", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [gone, kept], dependencies: [GONE_TO_KEPT] }), [
        lost("src/gone.ts", "over-size"),
      ]),
      makeIR({ symbols: [gone, kept] }),
    )
    expect(diff.summary).toMatchObject({ depsRemoved: 1, depsUnknown: 0 })
  })

  it("is an added + removed pair when its direction flipped, whatever either side lost", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept], dependencies: [GONE_TO_KEPT] }),
      withSkipped(
        makeIR({
          symbols: [gone, kept],
          dependencies: [call(gone.id, kept.id, { direction: "inbound" })],
        }),
        [lost("src/gone.ts")],
      ),
    )
    expect(diff.summary).toMatchObject({ depsAdded: 1, depsRemoved: 1, depsUnknown: 0 })
  })

  it("does not exist when both sides lost the file, since neither holds it", () => {
    const skipped = [lost("src/gone.ts", "over-size")]
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), skipped),
      withSkipped(makeIR({ symbols: [kept] }), skipped),
    )
    expect(diff.dependencies.unknown).toEqual([])
    expect(diff.summary.depsUnknown).toBe(0)
  })
})

describe("the three edge outcomes", () => {
  it("are counted apart, each edge in exactly one array", () => {
    const diff = diffOf(
      makeIR({ symbols: [gone, kept], dependencies: [GONE_TO_KEPT, imports("billing", "legacy")] }),
      withSkipped(makeIR({ symbols: [kept], dependencies: [imports("billing", "payments")] }), [
        lost("src/gone.ts"),
      ]),
    )
    expect(diff.summary).toMatchObject({ depsAdded: 1, depsRemoved: 1, depsUnknown: 1 })
    expect(diff.dependencies).toEqual({
      added: [imports("billing", "payments")],
      removed: [imports("billing", "legacy")],
      unknown: [{ dependency: GONE_TO_KEPT, absentFrom: "head", lostFiles: [lost("src/gone.ts")] }],
    })
  })

  it("write the unknown array and its counter even when nothing was unknown", () => {
    const diff = diffOf(makeIR({ symbols: [kept] }), makeIR({ symbols: [kept] }))
    expect(diff.dependencies.unknown).toEqual([])
    expect(diff.summary.depsUnknown).toBe(0)
  })
})

describe("diffDependencies given side views with nothing to say", () => {
  it("classifies every one-sided edge plainly, and still writes the unknown array", () => {
    const blind: DependencySideView = { symbolFiles: new Map(), lostFiles: new Map() }
    const result = diffDependencies([GONE_TO_KEPT], [imports("billing", "pricing")], {
      base: blind,
      head: blind,
      renames: renameDirections(null),
    })
    expect(result).toEqual({
      added: [imports("billing", "pricing")],
      removed: [GONE_TO_KEPT],
      unknown: [],
    })
  })
})
