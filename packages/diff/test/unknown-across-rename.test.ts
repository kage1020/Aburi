import { makeIR, makeSymbol } from "@aburi/test-support"
import type { Dependency, IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

/**
 * A file git renamed between the revisions is one file under two names, and the document that
 * skipped it recorded the name it had on its own side. A leftover from it names the file the
 * other way, so §3.5.1's lookup has to go through the rename map, or the Symbols of a renamed
 * file the other side skipped come out as confident `removed` / `added` (diff-algorithm.md
 * DF19j).
 */

function dep(from: string, to: string): Dependency {
  return { from, to, via: "call", direction: "outbound", effect: null } as Dependency
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

const RENAMES = new Map([["src/big.ts", "src/billing.ts"]])
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
const atOld = makeSymbol({ id: "ts:src/big.ts#Billing", name: "Billing" })
const atNew = makeSymbol({ id: "ts:src/billing.ts#Billing", name: "Billing" })

function diffOf(baseIR: IR, headIR: IR, gitRenames: ReadonlyMap<string, string> | null = RENAMES) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF, gitRenames })
}

describe("buildDiff — a renamed file one side skipped", () => {
  it("leaves the base Symbols unknown when the head skipped the new path", () => {
    const diff = diffOf(
      makeIR({ symbols: [kept, atOld] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.unknown).toBe(1)
    expect(diff.symbols).toEqual([
      { status: "unknown", symbol: atOld, absentFrom: "head", reason: "over-size" },
    ])
    expect(diff.notCompared).toEqual([])
  })

  it("leaves the head Symbols unknown when the base skipped the old path", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "over-size" }]),
      makeIR({ symbols: [kept, atNew] }),
    )

    expect(diff.summary.added).toBe(0)
    expect(diff.symbols).toEqual([
      { status: "unknown", symbol: atNew, absentFrom: "base", reason: "over-size" },
    ])
  })

  it("still reports a deletion when there is no rename map to read", () => {
    // `--base`/`--head` IR files carry no git history: the path is all there is to go on.
    const diff = diffOf(
      makeIR({ symbols: [kept, atOld] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
      null,
    )

    expect(diff.summary.removed).toBe(1)
    expect(diff.summary.unknown).toBe(0)
  })

  it("names the file the absent side recorded on an edge it lost", () => {
    // `lostFiles[]` is copied from that side's `stats.skippedFiles[]`, so it is the head's name.
    const diff = diffOf(
      makeIR({
        symbols: [kept, atOld],
        dependencies: [dep("ts:src/big.ts#Billing", "ts:src/kept.ts#kept")],
      }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.summary.depsRemoved).toBe(0)
    expect(diff.dependencies.unknown).toEqual([
      {
        dependency: dep("ts:src/big.ts#Billing", "ts:src/kept.ts#kept"),
        absentFrom: "head",
        lostFiles: [{ path: "src/billing.ts", reason: "over-size" }],
      },
    ])
  })

  it("names the base's path on an edge only the head holds", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "parse-timeout" }]),
      makeIR({
        symbols: [kept, atNew],
        dependencies: [dep("ts:src/kept.ts#kept", "ts:src/billing.ts#Billing")],
      }),
    )

    expect(diff.summary.depsAdded).toBe(0)
    expect(diff.dependencies.unknown).toEqual([
      {
        dependency: dep("ts:src/kept.ts#kept", "ts:src/billing.ts#Billing"),
        absentFrom: "base",
        lostFiles: [{ path: "src/big.ts", reason: "parse-timeout" }],
      },
    ])
  })
})

describe("buildDiff — a renamed file both sides skipped", () => {
  it("is one notCompared entry, under the head path with the base path alongside", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "parse-timeout" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.notCompared).toEqual([
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "parse-timeout",
        headReason: "over-size",
      },
    ])
  })

  it("carries no basePath for a file skipped under the same name", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/same.ts", reason: "over-size" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/same.ts", reason: "over-size" }]),
    )

    expect(diff.notCompared).toEqual([
      { path: "src/same.ts", baseReason: "over-size", headReason: "over-size" },
    ])
  })
})
