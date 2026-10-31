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

describe("a removed duplicate of a head Symbol", () => {
  it.each([
    [
      "two identical helpers deduplicated into one",
      [helper("src/a.test.ts", "makeEmptyIR"), helper("src/b.test.ts", "emptyIR")],
      [helper("src/fixtures.ts", "emptyIR")],
      "ts:src/a.test.ts#makeEmptyIR",
      "ts:src/fixtures.ts#emptyIR",
      1,
    ],
    [
      "a duplicate deleted beside its unchanged twin",
      [helper("src/a.ts", "emptyIR"), helper("src/b.ts", "blankIR")],
      [helper("src/a.ts", "emptyIR")],
      "ts:src/b.ts#blankIR",
      "ts:src/a.ts#emptyIR",
      1,
    ],
    [
      "duplicates whose survivor took a new name",
      [helper("src/a.ts", "makeEmptyIR"), helper("src/b.ts", "blankIR")],
      [helper("src/fixtures.ts", "documentWithNothing")],
      "ts:src/a.ts#makeEmptyIR",
      "ts:src/fixtures.ts#documentWithNothing",
      2,
    ],
  ])("names the survivor for %s", (_, base, head, removedId, survivor, removed) => {
    const diff = diffSymbols(base, head)

    expect(
      diff.symbols.find((change) => change.status === "removed" && change.symbol.id === removedId),
    ).toMatchObject({ duplicateOf: survivor })
    expect(diff.summary).toMatchObject({ removed, removedDuplicates: removed })
  })

  it("names the head Symbol whose name is closest when several hold the body", () => {
    const twins = [helper("src/a.ts", "zeroDocument"), helper("src/z.ts", "emptyIR")]
    const { entry } = removal([...twins, helper("src/b.ts", "makeEmptyIR")], twins)
    expect(entry.duplicateOf).toBe("ts:src/z.ts#emptyIR")
  })

  const TIED = [helper("src/b.ts", "emptyIR"), helper("src/c.ts", "emptyIR")]

  it.each([
    ["in id order", TIED],
    ["in reverse id order", [...TIED].reverse()],
  ])("names the lower id when two names tie, the head written %s", (_, twins) => {
    const { entry } = removal([helper("src/a.ts", "emptyIR"), ...TIED], twins)
    expect(entry.duplicateOf).toBe("ts:src/b.ts#emptyIR")
  })
})

describe("a removed Symbol that duplicates nothing on the head side", () => {
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

    expect(entry).toEqual({ status: "removed", symbol: base, duplicateOf: null })
    expect(summary).toMatchObject({ removed: 1, removedDuplicates: 0 })
  })

  it("is bare when a plugin gave it an extKind, a role its body does not hold", () => {
    const route = (file: string) => helper(file, "GET", { extKind: "framework:next:route" })
    const { entry } = removal(
      [route("app/v1/route.ts"), route("app/v2/route.ts")],
      [route("app/v2/route.ts")],
    )
    expect(entry.duplicateOf).toBeNull()
  })

  it("is bare beside a head Symbol with its logic and a body written otherwise", () => {
    const kept = helper("src/a.ts", "requireTree")
    const otherBody = { fingerprint: { ...kept.fingerprint, syntax: "cccccccccccc" } }
    const { entry } = removal([kept, helper("src/b.ts", "classifyEach", otherBody)], [kept])
    expect(entry.duplicateOf).toBeNull()
  })
})
