import { makeSymbol, rule } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffSymbols, soleChange } from "./helpers"

const EMPTY_IR_LOGIC = "e0e0e0e0e0e0"

function helper(file: string, name: string, overrides: Partial<IRSymbol> = {}): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    fingerprint: { api: "aaaaaaaaaaaa", logic: EMPTY_IR_LOGIC, syntax: "bbbbbbbbbbbb" },
    rules: [rule({ type: "return", expr: "{ symbols: [] }", line: 2 })],
    ...overrides,
  })
}

function removal(base: readonly IRSymbol[], head: readonly IRSymbol[]) {
  const diff = diffSymbols(base, head)
  return { entry: soleChange(diff.symbols, "removed"), summary: diff.summary }
}

describe("a removed Symbol whose logic a head Symbol still carries", () => {
  it.each([
    [
      "two identical helpers folded into one",
      [helper("src/a.test.ts", "makeEmptyIR"), helper("src/b.test.ts", "emptyIR")],
      [helper("src/fixtures.ts", "emptyIR")],
      "ts:src/a.test.ts#makeEmptyIR",
      "ts:src/fixtures.ts#emptyIR",
    ],
    [
      "a duplicate deleted beside its unchanged twin",
      [helper("src/a.ts", "emptyIR"), helper("src/b.ts", "blankIR")],
      [helper("src/a.ts", "emptyIR")],
      "ts:src/b.ts#blankIR",
      "ts:src/a.ts#emptyIR",
    ],
    [
      "a duplicate whose survivor took a new name",
      [helper("src/a.ts", "makeEmptyIR"), helper("src/b.ts", "blankIR")],
      [helper("src/fixtures.ts", "documentWithNothing")],
      "ts:src/a.ts#makeEmptyIR",
      "ts:src/fixtures.ts#documentWithNothing",
    ],
  ])("names the survivor for %s", (_, base, head, removedId, survivor) => {
    const diff = diffSymbols(base, head)
    const removed = diff.symbols.filter((change) => change.status === "removed")

    expect(removed.find((change) => change.symbol.id === removedId)?.foldedInto).toBe(survivor)
    expect(diff.summary.removedFolded).toBe(removed.length)
  })

  it("names the head Symbol whose name is closest when several carry the logic", () => {
    const twins = [helper("src/a.ts", "emptyIR"), helper("src/a.ts", "zeroDocument")]
    const { entry } = removal([...twins, helper("src/b.ts", "makeEmptyIR")], twins)
    expect(entry.foldedInto).toBe("ts:src/a.ts#emptyIR")
  })
})

describe("a removed Symbol nothing on the head side carries", () => {
  const OTHER_LOGIC = { api: "aaaaaaaaaaaa", logic: "111111111111", syntax: "bbbbbbbbbbbb" }
  const BARE = { rules: [] }

  it.each<[string, Partial<IRSymbol>, Partial<IRSymbol>]>([
    ["no head Symbol with its logic", {}, { fingerprint: OTHER_LOGIC }],
    ["logic that names nothing", BARE, BARE],
    ["a head Symbol of another kind", {}, { kind: "class" }],
    ["a dropped head Symbol", {}, { dropped: true, dropReason: "size" }],
  ])("is bare beside %s, and says so with null", (_, removed, survivor) => {
    const base = helper("src/a.ts", "makeEmptyIR", removed)
    const { entry, summary } = removal([base], [helper("src/b.ts", "zeroDocument", survivor)])

    expect(entry).toEqual({ status: "removed", symbol: base, foldedInto: null })
    expect(summary).toMatchObject({ removed: 1, removedFolded: 0 })
  })

  it("is bare beside a head Symbol with its logic and a body written otherwise", () => {
    const kept = helper("src/a.ts", "requireTree")
    const otherBody = { fingerprint: { ...kept.fingerprint, syntax: "cccccccccccc" } }
    const { entry } = removal([kept, helper("src/b.ts", "classifyEach", otherBody)], [kept])
    expect(entry.foldedInto).toBeNull()
  })
})
