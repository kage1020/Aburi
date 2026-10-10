import { makeIR, makeSymbol } from "@aburi/test-support"
import type { IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffOf, withSkipped } from "./helpers"

const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
const gone = makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })

const keptLosing = (skipped: readonly SkippedFile[]) =>
  withSkipped(makeIR({ symbols: [kept] }), skipped)

describe("a file both scans gave up on", () => {
  it("is reported with each side's own reason, and contributes no Symbol change", () => {
    const diff = diffOf(
      keptLosing([{ path: "vendor/huge.ts", reason: "parse-timeout" }]),
      keptLosing([{ path: "vendor/huge.ts", reason: "over-size" }]),
    )
    expect(diff.notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "parse-timeout", headReason: "over-size" },
    ])
    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ unknown: 0, removed: 0 })
  })

  it("is listed once per path, sorted by path, leaving one-sided losses out", () => {
    const diff = diffOf(
      keptLosing([
        { path: "a/one.ts", reason: "unroutable" },
        { path: "b/two.ts", reason: "over-size" },
        { path: "c/three.ts", reason: "parse-failed" },
      ]),
      keptLosing([
        { path: "b/two.ts", reason: "over-size" },
        { path: "c/three.ts", reason: "extraction-failed" },
        { path: "d/four.ts", reason: "unreadable" },
      ]),
    )
    expect(diff.notCompared).toEqual([
      { path: "b/two.ts", baseReason: "over-size", headReason: "over-size" },
      { path: "c/three.ts", baseReason: "parse-failed", headReason: "extraction-failed" },
    ])
  })

  it("is ordered by path, not by the order the skip lists arrived in", () => {
    const paths: SkippedFile[] = [
      { path: "z/last.ts", reason: "over-size" },
      { path: "a/first.ts", reason: "over-size" },
    ]
    const forward = diffOf(keptLosing(paths), keptLosing(paths))
    const reversed = diffOf(keptLosing([...paths].reverse()), keptLosing([...paths].reverse()))
    expect(forward.notCompared.map((f) => f.path)).toEqual(["a/first.ts", "z/last.ts"])
    expect(reversed.notCompared).toStrictEqual(forward.notCompared)
  })

  it("is ordered by path and then by the base's name for it across renames, whatever the input order", () => {
    const baseLosses: SkippedFile[] = [
      { path: "src/a.ts", reason: "over-size" },
      { path: "src/y.ts", reason: "parse-failed" },
      { path: "src/z.ts", reason: "parse-timeout" },
    ]
    const headLosses: SkippedFile[] = [
      { path: "src/z.ts", reason: "over-size" },
      { path: "src/b.ts", reason: "parse-failed" },
    ]
    const renames: [string, string][] = [
      ["src/a.ts", "src/z.ts"],
      ["src/y.ts", "src/b.ts"],
    ]
    const forward = diffOf(keptLosing(baseLosses), keptLosing(headLosses), {
      gitRenames: new Map(renames),
    })
    const reversed = diffOf(
      keptLosing([...baseLosses].reverse()),
      keptLosing([...headLosses].reverse()),
      {
        gitRenames: new Map([...renames].reverse()),
      },
    )
    expect(forward.notCompared.map((file) => [file.path, file.basePath ?? null])).toEqual([
      ["src/b.ts", "src/y.ts"],
      ["src/z.ts", "src/a.ts"],
      ["src/z.ts", null],
    ])
    expect(reversed.notCompared).toStrictEqual(forward.notCompared)
  })

  it("is read from the skip lists, even where a document contradicts its own", () => {
    const inBoth = { path: "src/kept.ts", reason: "parse-failed" } as const
    const diff = diffOf(keptLosing([inBoth]), withSkipped(makeIR(), [inBoth]))
    expect(diff.notCompared).toEqual([
      { path: "src/kept.ts", baseReason: "parse-failed", headReason: "parse-failed" },
    ])
    expect(diff.summary.unknown).toBe(1)
  })
})

describe("a file only one scan gave up on", () => {
  it.each<[string, () => [IR, IR]]>([
    [
      "head",
      () => [
        makeIR({ symbols: [kept, gone] }),
        keptLosing([{ path: "src/gone.ts", reason: "parse-failed" }]),
      ],
    ],
    [
      "base",
      () => [
        keptLosing([{ path: "src/gone.ts", reason: "parse-failed" }]),
        makeIR({ symbols: [kept, gone] }),
      ],
    ],
  ])("is left to unknown when %s lost it", (_, sides) => {
    const diff = diffOf(...sides())
    expect(diff.notCompared).toEqual([])
    expect(diff.summary.unknown).toBe(1)
  })

  it("is told apart from a file both lost in the same diff", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept, gone] }), [
        { path: "vendor/huge.ts", reason: "over-size" },
      ]),
      keptLosing([
        { path: "src/gone.ts", reason: "parse-failed" },
        { path: "vendor/huge.ts", reason: "over-size" },
      ]),
    )
    expect(diff.notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" },
    ])
    expect(diff.summary.unknown).toBe(1)
  })
})

describe("a document that predates stats.skippedFiles", () => {
  it("contributes nothing to notCompared", () => {
    const predating: IR = {
      ...makeIR({ symbols: [kept] }),
      stats: { ...makeIR({ symbols: [kept] }).stats, totalFiles: 3, parsedFiles: 1 },
    }
    expect(diffOf(predating, predating).notCompared).toEqual([])
  })
})
