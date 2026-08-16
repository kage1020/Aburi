import type { IR, Symbol as IRSymbol, SkippedFile, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src"
import { fp, makeIR, makeSymbol } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

/**
 * A Symbol missing from a file the other side never analysed is not a deletion.
 *
 * Before `stats.skippedFiles` existed, a scan that withdrew a file left no trace inside the
 * IR — `parsedFiles` fell below `totalFiles` and nothing named the file — so the next diff
 * reported every Symbol in it as removed API, and `--fail-on removed` tripped with the wrong
 * explanation. The document now says what it lost, and the diff says "unknown" where it
 * used to say "removed".
 */

function withSkipped(ir: IR, skipped: readonly SkippedFile[], totalFiles = 2): IR {
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

function lost(path: string, reason: SkippedFile["reason"] = "parse-failed"): SkippedFile {
  return { path, reason }
}

function unknowns(symbols: readonly { status: string }[]): SymbolUnknown[] {
  return symbols.filter((c): c is SymbolUnknown => c.status === "unknown")
}

function diffOf(baseIR: IR, headIR: IR) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF })
}

const foo = makeSymbol({ id: "ts:src/gone.ts#foo", name: "foo" })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

describe("buildDiff — a Symbol in a file the other side never analysed", () => {
  it("is unknown, not removed, when head lost the file", () => {
    const base = makeIR({ symbols: [foo, kept] })
    const head = withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")])
    const result = diffOf(base, head)

    expect(result.summary.removed).toBe(0)
    expect(result.summary.unknown).toBe(1)
    expect(unknowns(result.symbols)).toEqual([
      { status: "unknown", symbol: foo, absentFrom: "head", reason: "parse-failed" },
    ])
  })

  it("is unknown, not added, when base lost the file", () => {
    // The same defect in the other direction: a file fine at head and withdrawn at base
    // makes every Symbol in it look brand new.
    const base = withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts", "parse-timeout")])
    const head = makeIR({ symbols: [foo, kept] })
    const result = diffOf(base, head)

    expect(result.summary.added).toBe(0)
    expect(result.summary.unknown).toBe(1)
    expect(unknowns(result.symbols)).toEqual([
      { status: "unknown", symbol: foo, absentFrom: "base", reason: "parse-timeout" },
    ])
  })

  it("carries the reason, because it decides what the reader does next", () => {
    // `parse-timeout` depends on how loaded the machine was and usually clears on a re-run;
    // the others describe the file and clear only when it is fixed.
    for (const reason of ["over-size", "unroutable", "extraction-failed"] as const) {
      const base = makeIR({ symbols: [foo] })
      const head = withSkipped(makeIR({ symbols: [] }), [lost("src/gone.ts", reason)], 1)
      expect(unknowns(diffOf(base, head).symbols)[0]?.reason).toBe(reason)
    }
  })

  it("still reports a genuine deletion as removed", () => {
    const base = makeIR({ symbols: [foo, kept] })
    const head = withSkipped(makeIR({ symbols: [kept] }), [lost("src/other.ts")])
    const result = diffOf(base, head)

    expect(result.summary.removed).toBe(1)
    expect(result.summary.unknown).toBe(0)
  })

  it("leaves a Symbol that moved out of the lost file as moved", () => {
    // The classification runs on the matcher's leftovers, never on the base list. A Symbol
    // that survived into a file head *does* have was matched by fingerprint, and head holds
    // real evidence for it — calling that unknown would throw away an answer.
    const moved: IRSymbol = makeSymbol({ id: "ts:src/here.ts#foo", name: "foo" })
    const base = makeIR({ symbols: [foo] })
    const head = withSkipped(makeIR({ symbols: [moved] }), [lost("src/gone.ts")], 2)
    const result = diffOf(base, head)

    expect(result.summary.unknown).toBe(0)
    expect(result.summary.moved).toBe(1)
  })

  it("counts a dropped leftover as droppedRemoved rather than unknown", () => {
    // Dropped Symbols produce no `symbols[]` entry on either side today and nothing gates
    // on their counters. Routing them here would add entries where there were none.
    const droppedFoo = makeSymbol({
      id: "ts:src/gone.ts#foo",
      name: "foo",
      dropped: true,
      dropReason: "test-file",
    })
    const base = makeIR({ symbols: [droppedFoo] })
    const head = withSkipped(makeIR({ symbols: [] }), [lost("src/gone.ts")], 1)
    const result = diffOf(base, head)

    expect(result.summary.droppedRemoved).toBe(1)
    expect(result.summary.unknown).toBe(0)
  })

  it("changes nothing for a document that never recorded what it lost", () => {
    // Class B: absence means the writer predates the field. The counts still say a file went
    // missing, but with no list the diff cannot say which Symbols it took — so it reports
    // what it can see, and the CLI warns that the check was unavailable.
    const base = makeIR({ symbols: [foo, kept] })
    const head: IR = {
      ...makeIR({ symbols: [kept] }),
      stats: { ...makeIR().stats, totalFiles: 2, parsedFiles: 1 },
    }
    const result = diffOf(base, head)

    expect(result.summary.removed).toBe(1)
    expect(result.summary.unknown).toBe(0)
  })

  it("counts both directions in one diff", () => {
    // Each direction alone leaves a missed increment on the single counter invisible, and
    // says nothing about how the two sort against each other.
    // Distinct fingerprints, or stage 3 pairs the two as one Symbol that moved.
    const goneFromHead = makeSymbol({
      id: "ts:src/a-gone.ts#fromBase",
      name: "fromBase",
      fingerprint: fp("one"),
    })
    const goneFromBase = makeSymbol({
      id: "ts:src/b-gone.ts#fromHead",
      name: "fromHead",
      fingerprint: fp("two"),
    })
    const base = withSkipped(
      makeIR({ symbols: [goneFromHead, kept] }),
      [lost("src/b-gone.ts", "over-size")],
      3,
    )
    const head = withSkipped(
      makeIR({ symbols: [goneFromBase, kept] }),
      [lost("src/a-gone.ts", "parse-failed")],
      3,
    )
    const result = diffOf(base, head)

    expect(result.summary.unknown).toBe(2)
    expect(result.summary.added).toBe(0)
    expect(result.summary.removed).toBe(0)
    expect(unknowns(result.symbols).map((c) => [c.symbol.id, c.absentFrom, c.reason])).toEqual([
      ["ts:src/a-gone.ts#fromBase", "head", "parse-failed"],
      ["ts:src/b-gone.ts#fromHead", "base", "over-size"],
    ])
  })

  it("sorts against the other statuses, not only against itself", () => {
    // `symbols[]` is ordered by (status, reference id) and the file is byte-stable, so the
    // position of a new status among the existing ones is a contract.
    const addedSym = makeSymbol({
      id: "ts:src/new.ts#fresh",
      name: "fresh",
      fingerprint: fp("three"),
    })
    const removedSym = makeSymbol({
      id: "ts:src/old.ts#stale",
      name: "stale",
      fingerprint: fp("four"),
    })
    const base = withSkipped(makeIR({ symbols: [foo, removedSym] }), [lost("src/nothing.ts")], 3)
    const head = withSkipped(makeIR({ symbols: [addedSym] }), [lost("src/gone.ts")], 3)
    const statuses = diffOf(base, head).symbols.map((c) => c.status)

    expect(statuses).toEqual(["added", "removed", "unknown"])
  })

  it("makes an unknown Symbol a Slice View node, as added and removed are", () => {
    // `nodeIdOf` returning null for this status would drop it from every Slice silently and
    // make the projection's unknown label dead code.
    const base = makeIR({ symbols: [foo, kept] })
    const head = withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")])
    const members = diffOf(base, head).slices.flatMap((s) => s.members)

    expect(members).toContain("ts:src/gone.ts#foo")
  })

  it("sorts and serialises beside the other statuses", () => {
    const other = makeSymbol({ id: "ts:src/gone.ts#bar", name: "bar" })
    const base = makeIR({ symbols: [foo, other, kept] })
    const head = withSkipped(makeIR({ symbols: [] }), [lost("src/gone.ts"), lost("src/kept.ts")], 2)
    const result = diffOf(base, head)

    expect(result.summary.unknown).toBe(3)
    const ids = unknowns(result.symbols).map((c) => c.symbol.id)
    expect(ids).toEqual([...ids].sort())
  })
})
