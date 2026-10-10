import { dependency, makeIR, makeSymbol } from "@aburi/test-support"
import type { IR, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { renameDirections } from "../src"
import { diffOf, withSkipped } from "./helpers"

function call(from: string, to: string) {
  return dependency({ from, to, via: "call" })
}

const RENAMES = new Map([["src/big.ts", "src/billing.ts"]])
const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
const atOld = makeSymbol({ id: "ts:src/big.ts#Billing", name: "Billing" })
const atNew = makeSymbol({ id: "ts:src/billing.ts#Billing", name: "Billing" })

function diffAcrossRename(
  baseIR: IR,
  headIR: IR,
  gitRenames: ReadonlyMap<string, string> | null = RENAMES,
) {
  return diffOf(baseIR, headIR, { gitRenames })
}

describe("a renamed file one side skipped", () => {
  it("leaves the base Symbols unknown when the head skipped the new path", () => {
    const diff = diffAcrossRename(
      makeIR({ symbols: [kept, atOld] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.unknown).toBe(1)
    expect(diff.symbols).toStrictEqual([
      {
        status: "unknown",
        symbol: atOld,
        absentFrom: "head",
        reason: "over-size",
        lostPath: "src/billing.ts",
      },
    ])
    expect(diff.notCompared).toEqual([])
  })

  it("leaves the head Symbols unknown when the base skipped the old path", () => {
    const diff = diffAcrossRename(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "over-size" }]),
      makeIR({ symbols: [kept, atNew] }),
    )

    expect(diff.summary.added).toBe(0)
    expect(diff.symbols).toStrictEqual([
      {
        status: "unknown",
        symbol: atNew,
        absentFrom: "base",
        reason: "over-size",
        lostPath: "src/big.ts",
      },
    ])
  })

  it("carries no lostPath when the other side skipped the file under the Symbol's own name", () => {
    const diff = diffAcrossRename(
      makeIR({ symbols: [kept, atOld] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "parse-failed" }]),
      new Map([["src/other.ts", "src/elsewhere.ts"]]),
    )

    const [entry] = diff.symbols
    expect(entry).toStrictEqual({
      status: "unknown",
      symbol: atOld,
      absentFrom: "head",
      reason: "parse-failed",
    })
    expect(entry !== undefined && "lostPath" in entry).toBe(false)
  })

  it("still reports a deletion when there is no rename map to read", () => {
    const diff = diffAcrossRename(
      makeIR({ symbols: [kept, atOld] }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
      null,
    )

    expect(diff.summary.removed).toBe(1)
    expect(diff.summary.unknown).toBe(0)
  })

  it("answers from the lowest base path when a hand-built map renames two onto one head path", () => {
    const baseIR = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/b.ts", reason: "over-size" },
      { path: "src/a.ts", reason: "parse-timeout" },
    ])
    const headIR = makeIR({ symbols: [kept, atNew] })
    const forward = diffAcrossRename(
      baseIR,
      headIR,
      new Map([
        ["src/a.ts", "src/billing.ts"],
        ["src/b.ts", "src/billing.ts"],
      ]),
    )
    const reversed = diffAcrossRename(
      baseIR,
      headIR,
      new Map([
        ["src/b.ts", "src/billing.ts"],
        ["src/a.ts", "src/billing.ts"],
      ]),
    )

    const expected = [
      {
        status: "unknown",
        symbol: atNew,
        absentFrom: "base",
        reason: "parse-timeout",
        lostPath: "src/a.ts",
      },
    ]
    expect(forward.symbols).toStrictEqual(expected)
    expect(reversed.symbols).toStrictEqual(expected)
  })
})

describe("an edge into a renamed file one side skipped", () => {
  it("names the file the absent side recorded on an edge it lost", () => {
    const diff = diffAcrossRename(
      makeIR({
        symbols: [kept, atOld],
        dependencies: [call("ts:src/big.ts#Billing", "ts:src/kept.ts#kept")],
      }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.summary.depsRemoved).toBe(0)
    expect(diff.dependencies.unknown).toStrictEqual([
      {
        dependency: call("ts:src/big.ts#Billing", "ts:src/kept.ts#kept"),
        absentFrom: "head",
        lostFiles: [{ path: "src/billing.ts", reason: "over-size" }],
      },
    ])
  })

  it("names the base's path on an edge only the head holds", () => {
    const diff = diffAcrossRename(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "parse-timeout" }]),
      makeIR({
        symbols: [kept, atNew],
        dependencies: [call("ts:src/kept.ts#kept", "ts:src/billing.ts#Billing")],
      }),
    )

    expect(diff.summary.depsAdded).toBe(0)
    expect(diff.dependencies.unknown).toStrictEqual([
      {
        dependency: call("ts:src/kept.ts#kept", "ts:src/billing.ts#Billing"),
        absentFrom: "base",
        lostFiles: [{ path: "src/big.ts", reason: "parse-timeout" }],
      },
    ])
  })

  it("collapses an edge inside a renamed file to the one file the absent side lost", () => {
    const helper = makeSymbol({ id: "ts:src/big.ts#charge", name: "charge" })
    const diff = diffAcrossRename(
      makeIR({
        symbols: [kept, atOld, helper],
        dependencies: [call("ts:src/big.ts#Billing", "ts:src/big.ts#charge")],
      }),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.dependencies.unknown?.map((entry) => entry.lostFiles)).toStrictEqual([
      [{ path: "src/billing.ts", reason: "over-size" }],
    ])
  })

  it("sorts lostFiles by the absent side's names, not the holder's", () => {
    const fromRenamed = makeSymbol({ id: "ts:src/a.ts#A", name: "A" })
    const toStaying = makeSymbol({ id: "ts:src/m.ts#M", name: "M" })
    const diff = diffAcrossRename(
      makeIR({
        symbols: [kept, fromRenamed, toStaying],
        dependencies: [call("ts:src/a.ts#A", "ts:src/m.ts#M")],
      }),
      withSkipped(makeIR({ symbols: [kept] }), [
        { path: "src/z.ts", reason: "parse-failed" },
        { path: "src/m.ts", reason: "over-size" },
      ]),
      new Map([["src/a.ts", "src/z.ts"]]),
    )

    expect(diff.dependencies.unknown?.map((entry) => entry.lostFiles)).toStrictEqual([
      [
        { path: "src/m.ts", reason: "over-size" },
        { path: "src/z.ts", reason: "parse-failed" },
      ],
    ])
  })
})

describe("a renamed file both sides skipped", () => {
  it("is one notCompared entry, under the head path with the base path alongside", () => {
    const diff = diffAcrossRename(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/big.ts", reason: "parse-timeout" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/billing.ts", reason: "over-size" }]),
    )

    expect(diff.notCompared).toStrictEqual([
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "parse-timeout",
        headReason: "over-size",
      },
    ])
  })

  it("carries no basePath for a file skipped under the same name", () => {
    const diff = diffAcrossRename(
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/same.ts", reason: "over-size" }]),
      withSkipped(makeIR({ symbols: [kept] }), [{ path: "src/same.ts", reason: "over-size" }]),
    )

    expect(diff.notCompared).toStrictEqual([
      { path: "src/same.ts", baseReason: "over-size", headReason: "over-size" },
    ])
  })

  it("keeps every base skip record a hand-built map leads to one head path, in either order", () => {
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/billing.ts", reason: "over-size" },
    ])
    const skippedAtBase: SkippedFile[] = [
      { path: "src/big.ts", reason: "over-size" },
      { path: "src/billing.ts", reason: "parse-timeout" },
    ]
    const forward = diffAcrossRename(withSkipped(makeIR({ symbols: [kept] }), skippedAtBase), head)
    const reversed = diffAcrossRename(
      withSkipped(makeIR({ symbols: [kept] }), [...skippedAtBase].reverse()),
      head,
    )

    const expected = [
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
      { path: "src/billing.ts", baseReason: "parse-timeout", headReason: "over-size" },
    ]
    expect(forward.notCompared).toStrictEqual(expected)
    expect(reversed.notCompared).toStrictEqual(expected)
  })
})

describe("renameDirections", () => {
  it("copies the map it is given, so a later change to it reaches no diff", () => {
    const renames = new Map([["src/big.ts", "src/billing.ts"]])
    const directions = renameDirections(renames)
    renames.set("src/other.ts", "src/elsewhere.ts")

    expect([...directions.baseToHead]).toStrictEqual([["src/big.ts", "src/billing.ts"]])
    expect([...directions.headToBase]).toStrictEqual([["src/billing.ts", ["src/big.ts"]]])
  })

  it("reads null as no rename information", () => {
    const directions = renameDirections(null)
    expect(directions.baseToHead.size).toBe(0)
    expect(directions.headToBase.size).toBe(0)
  })
})
