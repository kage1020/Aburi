import type { CallResolutionStats } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { formatCallResolutionLine } from "../src/call-resolution"

function stats(over: Partial<CallResolutionStats["unresolved"]> = {}): CallResolutionStats {
  const unresolved = {
    localScope: 0,
    external: 0,
    dynamic: 0,
    ambiguous: 0,
    noMatch: 0,
    ...over,
  }
  const total = Object.values(unresolved).reduce((a, b) => a + b, 0)
  return { totalCalls: total + 10, resolvedCalls: 10, unresolved }
}

describe("formatCallResolutionLine", () => {
  it("lists every non-zero bucket in call-resolution.md §8.1 table order", () => {
    expect(
      formatCallResolutionLine(
        stats({ localScope: 2, external: 30, dynamic: 60, ambiguous: 3, noMatch: 12 }),
      ),
    ).toBe(
      "calls 117 · resolved 10 · unresolved 107 (local-scope 2 · external 30 · dynamic 60 · ambiguous 3 · no-match 12)",
    )
  })

  it("omits zero buckets so the interesting ones stay readable", () => {
    expect(formatCallResolutionLine(stats({ dynamic: 4 }))).toBe(
      "calls 14 · resolved 10 · unresolved 4 (dynamic 4)",
    )
  })

  it("drops the parenthesis entirely when nothing is unresolved", () => {
    expect(formatCallResolutionLine(stats())).toBe("calls 10 · resolved 10 · unresolved 0")
  })

  it("handles a workspace with no call sites at all", () => {
    expect(
      formatCallResolutionLine({
        totalCalls: 0,
        resolvedCalls: 0,
        unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
      }),
    ).toBe("calls 0 · resolved 0 · unresolved 0")
  })
})
