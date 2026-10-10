import { fp, guardedBody, makeIR, makeSymbol } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol, SkippedFile, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

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

const foo = makeSymbol({ id: "ts:src/gone.ts#foo", name: "foo", rules: guardedBody("ready") })
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
    const moved: IRSymbol = makeSymbol({
      id: "ts:src/here.ts#foo",
      name: "foo",
      rules: guardedBody("ready"),
    })
    const base = makeIR({ symbols: [foo] })
    const head = withSkipped(makeIR({ symbols: [moved] }), [lost("src/gone.ts")], 2)
    const result = diffOf(base, head)

    expect(result.summary.unknown).toBe(0)
    expect(result.summary.moved).toBe(1)
  })

  it("counts a dropped leftover as droppedRemoved rather than unknown", () => {
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
