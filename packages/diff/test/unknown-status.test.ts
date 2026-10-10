import { fp, guardedBody, makeIR, makeSymbol } from "@aburi/test-support"
import type { IR, SkippedFile, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffOf, withSkipped } from "./helpers"

function lost(path: string, reason: SkippedFile["reason"] = "parse-failed"): SkippedFile {
  return { path, reason }
}

function unknowns(changes: readonly { status: string }[]): SymbolUnknown[] {
  return changes.filter((change): change is SymbolUnknown => change.status === "unknown")
}

const foo = makeSymbol({ id: "ts:src/gone.ts#foo", name: "foo", rules: guardedBody("ready") })
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })

describe("a Symbol in a file the other side never analysed", () => {
  it("is unknown, not removed, when head lost the file", () => {
    const diff = diffOf(
      makeIR({ symbols: [foo, kept] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")]),
    )
    expect(diff.summary).toMatchObject({ removed: 0, unknown: 1 })
    expect(unknowns(diff.symbols)).toEqual([
      { status: "unknown", symbol: foo, absentFrom: "head", reason: "parse-failed" },
    ])
  })

  it("is unknown, not added, when base lost the file", () => {
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts", "parse-timeout")]),
      makeIR({ symbols: [foo, kept] }),
    )
    expect(diff.summary).toMatchObject({ added: 0, unknown: 1 })
    expect(unknowns(diff.symbols)).toEqual([
      { status: "unknown", symbol: foo, absentFrom: "base", reason: "parse-timeout" },
    ])
  })

  it("is counted in both directions in one diff", () => {
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
    const diff = diffOf(
      withSkipped(makeIR({ symbols: [goneFromHead, kept] }), [lost("src/b-gone.ts", "over-size")]),
      withSkipped(makeIR({ symbols: [goneFromBase, kept] }), [lost("src/a-gone.ts")]),
    )
    expect(diff.summary).toMatchObject({ unknown: 2, added: 0, removed: 0 })
    expect(unknowns(diff.symbols).map((c) => [c.symbol.id, c.absentFrom, c.reason])).toEqual([
      ["ts:src/a-gone.ts#fromBase", "head", "parse-failed"],
      ["ts:src/b-gone.ts#fromHead", "base", "over-size"],
    ])
  })

  it("is a Slice Node, as added and removed Symbols are", () => {
    const diff = diffOf(
      makeIR({ symbols: [foo, kept] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/gone.ts")]),
    )
    expect(diff.slices.flatMap((slice) => slice.members)).toContain("ts:src/gone.ts#foo")
  })
})

describe("a Symbol that is not unknown although a file was lost", () => {
  it("is removed when the file the other side lost is a different one", () => {
    const diff = diffOf(
      makeIR({ symbols: [foo, kept] }),
      withSkipped(makeIR({ symbols: [kept] }), [lost("src/other.ts")]),
    )
    expect(diff.summary).toMatchObject({ removed: 1, unknown: 0 })
  })

  it("is moved when it left the lost file for another", () => {
    const moved = makeSymbol({ id: "ts:src/here.ts#foo", name: "foo", rules: guardedBody("ready") })
    const diff = diffOf(
      makeIR({ symbols: [foo] }),
      withSkipped(makeIR({ symbols: [moved] }), [lost("src/gone.ts")]),
    )
    expect(diff.summary).toMatchObject({ moved: 1, unknown: 0 })
  })

  it("is a dropped removal when it was dropped", () => {
    const droppedFoo = makeSymbol({
      id: "ts:src/gone.ts#foo",
      name: "foo",
      dropped: true,
      dropReason: "test-file",
    })
    const diff = diffOf(
      makeIR({ symbols: [droppedFoo] }),
      withSkipped(makeIR(), [lost("src/gone.ts")]),
    )
    expect(diff.summary).toMatchObject({ droppedRemoved: 1, unknown: 0 })
  })

  it("is removed when the other document never recorded what it lost", () => {
    const head: IR = {
      ...makeIR({ symbols: [kept] }),
      stats: { ...makeIR().stats, totalFiles: 2, parsedFiles: 1 },
    }
    const diff = diffOf(makeIR({ symbols: [foo, kept] }), head)
    expect(diff.summary).toMatchObject({ removed: 1, unknown: 0 })
  })
})
