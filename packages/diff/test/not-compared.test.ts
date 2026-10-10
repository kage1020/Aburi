import { makeIR, makeSymbol } from "@aburi/test-support"
import type { IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

function withSkipped(ir: IR, skipped: readonly SkippedFile[], totalFiles = 4): IR {
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

const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

function diffOf(baseIR: IR, headIR: IR) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF })
}

describe("notCompared — a path both scans gave up on", () => {
  it("carries the path with each side's own reason", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [
        { path: "vendor/huge.ts", reason: "parse-timeout" },
      ]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "vendor/huge.ts", reason: "over-size" }]),
    )
    expect(diff.notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "parse-timeout", headReason: "over-size" },
    ])
  })

  it("says nothing about a file only the head scan lost", () => {
    const diff = diffOf(
      makeIR({ symbols: [kept, makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/gone.ts", reason: "parse-failed" }]),
    )
    expect(diff.notCompared).toEqual([])
    expect(diff.summary.unknown).toBe(1)
  })

  it("says nothing about a file only the base scan lost", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/new.ts", reason: "parse-failed" }]),
      makeIR({ symbols: [kept, makeSymbol({ id: "ts:src/new.ts#fresh", name: "fresh" })] }),
    )
    expect(diff.notCompared).toEqual([])
    expect(diff.summary.unknown).toBe(1)
  })

  it("emits the key on a diff that lost nothing", () => {
    const diff = diffOf(makeIR({ symbols: [kept] }), makeIR({ symbols: [kept] }))
    expect(diff.notCompared).toEqual([])
  })

  it("emits the key when only one side lost anything", () => {
    const diff = diffOf(
      makeIR({ symbols: [kept] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/gone.ts", reason: "unreadable" }]),
    )
    expect(diff.notCompared).toEqual([])
  })

  it("lists every symmetric loss once, sorted by path", () => {
    const diff = diffOf(
      withSkipped(
        makeIR({ symbols: [kept] }),
        [
          { path: "a/one.ts", reason: "unroutable" },
          { path: "b/two.ts", reason: "over-size" },
          { path: "c/three.ts", reason: "parse-failed" },
        ],
        6,
      ),
      withSkipped(
        makeIR({ symbols: [kept] }),
        [
          { path: "b/two.ts", reason: "over-size" },
          { path: "c/three.ts", reason: "extraction-failed" },
          { path: "d/four.ts", reason: "unreadable" },
        ],
        6,
      ),
    )
    expect(diff.notCompared).toEqual([
      { path: "b/two.ts", baseReason: "over-size", headReason: "over-size" },
      { path: "c/three.ts", baseReason: "parse-failed", headReason: "extraction-failed" },
    ])
  })

  it("orders by path rather than by the order the skip lists arrived in", () => {
    const paths: SkippedFile[] = [
      { path: "z/last.ts", reason: "over-size" },
      { path: "a/first.ts", reason: "over-size" },
    ]
    const forward = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), paths, 5),
      withSkipped(makeIR({ symbols: [kept] }), paths, 5),
    )
    const reversed = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [...paths].reverse(), 5),
      withSkipped(makeIR({ symbols: [kept] }), [...paths].reverse(), 5),
    )
    expect(forward.notCompared.map((f) => f.path)).toEqual(["a/first.ts", "z/last.ts"])
    expect(JSON.stringify(reversed.notCompared)).toBe(JSON.stringify(forward.notCompared))
  })

  it("reports a file both scans lost even when neither lost anything else", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "vendor/bundle.js", reason: "over-size" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "vendor/bundle.js", reason: "over-size" }]),
    )
    expect(diff.symbols).toEqual([])
    expect(diff.summary.unknown).toBe(0)
    expect(diff.summary.removed).toBe(0)
    expect(diff.notCompared).toEqual([
      { path: "vendor/bundle.js", baseReason: "over-size", headReason: "over-size" },
    ])
  })

  it("splits a symmetric loss from a one-sided one in the same diff", () => {
    const diff = diffOf(
      withSkipped(
        makeIR({ symbols: [kept, makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })] }),
        [{ path: "vendor/huge.ts", reason: "over-size" }],
        5,
      ),
      withSkipped(
        makeIR({ symbols: [kept] }),
        [
          { path: "src/gone.ts", reason: "parse-failed" },
          { path: "vendor/huge.ts", reason: "over-size" },
        ],
        5,
      ),
    )
    expect(diff.notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" },
    ])
    expect(diff.summary.unknown).toBe(1)
    expect(diff.symbols.filter((c) => c.status === "unknown")).toHaveLength(1)
  })

  it("reads the skip lists, even where a document contradicts its own", () => {
    const inBoth = { path: "src/kept.ts", reason: "parse-failed" } as const
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [inBoth]),
      withSkipped(makeIR({ symbols: [] }), [inBoth]),
    )
    expect(diff.notCompared).toEqual([
      { path: "src/kept.ts", baseReason: "parse-failed", headReason: "parse-failed" },
    ])
    expect(diff.summary.unknown).toBe(1)
  })

  it("stays empty when a document predates stats.skippedFiles", () => {
    const predating: IR = {
      ...makeIR({ symbols: [kept] }),
      stats: { ...makeIR({ symbols: [kept] }).stats, totalFiles: 3, parsedFiles: 1 },
    }
    const diff = diffOf(predating, predating)
    expect(diff.notCompared).toEqual([])
  })
})
