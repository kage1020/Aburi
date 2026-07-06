import { describe, expect, it } from "vitest"
import {
  evaluateFailOn,
  type FailOnClause,
  formatFailOnClause,
  formatFailOnTriggered,
} from "../src"
import { emptySummary } from "./fixtures"

describe("formatFailOnClause (WI-13 AC 5)", () => {
  it("emits bare status for clauses with no threshold", () => {
    expect(formatFailOnClause({ status: "changed" })).toBe("changed")
    expect(formatFailOnClause({ status: "dropped-toggled" })).toBe("dropped-toggled")
  })

  it("emits `status:>N` when a threshold is attached", () => {
    expect(formatFailOnClause({ status: "changed", comparator: ">", count: 10 })).toBe(
      "changed:>10",
    )
  })

  it("supports dropped-toggled sub-directions", () => {
    expect(formatFailOnClause({ status: "dropped-toggled:to-kept" })).toBe(
      "dropped-toggled:to-kept",
    )
  })
})

describe("formatFailOnTriggered — diagnostic phrasing", () => {
  it("mentions the clause + observed count", () => {
    const clause: FailOnClause = { status: "changed", comparator: ">", count: 10 }
    expect(formatFailOnTriggered(clause, 42)).toBe(
      "--fail-on changed:>10 tripped (observed: 42 changed symbols)",
    )
  })

  it("handles bare-status clauses", () => {
    expect(formatFailOnTriggered({ status: "dropped-toggled" }, 3)).toBe(
      "--fail-on dropped-toggled tripped (observed: 3 dropped-toggled symbols)",
    )
  })
})

describe("evaluateFailOn — trigger evaluation", () => {
  it("fires bare status when observed > 0", () => {
    const summary = { ...emptySummary(), changed: 1 }
    expect(evaluateFailOn({ status: "changed" }, summary)).toEqual({
      triggered: true,
      observed: 1,
    })
  })

  it("does not fire when observed = 0", () => {
    const summary = emptySummary()
    expect(evaluateFailOn({ status: "changed" }, summary).triggered).toBe(false)
  })

  it("applies > comparator strictly (>10 not fired at 10)", () => {
    const summary = { ...emptySummary(), changed: 10 }
    expect(
      evaluateFailOn({ status: "changed", comparator: ">", count: 10 }, summary).triggered,
    ).toBe(false)
    const above = { ...emptySummary(), changed: 11 }
    expect(evaluateFailOn({ status: "changed", comparator: ">", count: 10 }, above).triggered).toBe(
      true,
    )
  })

  it("applies >= comparator inclusively", () => {
    const summary = { ...emptySummary(), changed: 10 }
    expect(
      evaluateFailOn({ status: "changed", comparator: ">=", count: 10 }, summary).triggered,
    ).toBe(true)
  })

  it("evaluates dropped-toggled:to-kept from the caller-supplied breakdown", () => {
    const summary = { ...emptySummary(), droppedToggled: 5 }
    // Breakdown: 3 to-dropped + 2 to-kept
    const evalKept = evaluateFailOn({ status: "dropped-toggled:to-kept" }, summary, {
      toDropped: 3,
      toKept: 2,
    })
    expect(evalKept.observed).toBe(2)
    expect(evalKept.triggered).toBe(true)
    const evalDropped = evaluateFailOn({ status: "dropped-toggled:to-dropped" }, summary, {
      toDropped: 3,
      toKept: 2,
    })
    expect(evalDropped.observed).toBe(3)
  })
})
