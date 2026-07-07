import { describe, expect, it } from "vitest"
import {
  evaluateFailOn,
  type FailOnClause,
  formatFailOnClause,
  formatFailOnTriggered,
} from "../src"
import { emptySummary } from "./fixtures"

describe("formatFailOnClause", () => {
  it("emits bare status for clauses with no threshold", () => {
    expect(formatFailOnClause({ kind: "bare", status: "changed" })).toBe("changed")
    expect(formatFailOnClause({ kind: "bare", status: "dropped-toggled" })).toBe("dropped-toggled")
  })

  it("emits `status:>N` when a threshold is attached", () => {
    expect(
      formatFailOnClause({
        kind: "threshold",
        status: "changed",
        comparator: ">",
        count: 10,
      }),
    ).toBe("changed:>10")
  })

  it("supports dropped-toggled sub-directions", () => {
    expect(formatFailOnClause({ kind: "bare", status: "dropped-toggled:to-kept" })).toBe(
      "dropped-toggled:to-kept",
    )
  })
})

describe("formatFailOnTriggered — diagnostic phrasing", () => {
  it("mentions the clause + observed count", () => {
    const clause: FailOnClause = {
      kind: "threshold",
      status: "changed",
      comparator: ">",
      count: 10,
    }
    expect(formatFailOnTriggered(clause, 42)).toBe(
      "--fail-on changed:>10 tripped (observed: 42 changed symbols)",
    )
  })

  it("handles bare-status clauses", () => {
    expect(formatFailOnTriggered({ kind: "bare", status: "dropped-toggled" }, 3)).toBe(
      "--fail-on dropped-toggled tripped (observed: 3 dropped-toggled symbols)",
    )
  })
})

describe("evaluateFailOn — bare-status branch", () => {
  it("fires when observed > 0", () => {
    const summary = { ...emptySummary(), changed: 1 }
    expect(evaluateFailOn({ kind: "bare", status: "changed" }, summary)).toEqual({
      triggered: true,
      observed: 1,
    })
  })

  it("does not fire when observed = 0", () => {
    const summary = emptySummary()
    expect(evaluateFailOn({ kind: "bare", status: "changed" }, summary).triggered).toBe(false)
  })
})

describe("evaluateFailOn — comparator matrix", () => {
  const observedAt = (value: number) => ({ ...emptySummary(), changed: value })

  it("applies > strictly (10 vs threshold 10 = false)", () => {
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: ">", count: 10 },
        observedAt(10),
      ).triggered,
    ).toBe(false)
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: ">", count: 10 },
        observedAt(11),
      ).triggered,
    ).toBe(true)
  })

  it("applies >= inclusively (10 vs threshold 10 = true)", () => {
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: ">=", count: 10 },
        observedAt(10),
      ).triggered,
    ).toBe(true)
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: ">=", count: 10 },
        observedAt(9),
      ).triggered,
    ).toBe(false)
  })

  it("applies == on exact match", () => {
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: "==", count: 5 },
        observedAt(5),
      ).triggered,
    ).toBe(true)
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: "==", count: 5 },
        observedAt(4),
      ).triggered,
    ).toBe(false)
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: "==", count: 5 },
        observedAt(6),
      ).triggered,
    ).toBe(false)
  })

  it("applies <= inclusively", () => {
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: "<=", count: 5 },
        observedAt(5),
      ).triggered,
    ).toBe(true)
    expect(
      evaluateFailOn(
        { kind: "threshold", status: "changed", comparator: "<=", count: 5 },
        observedAt(6),
      ).triggered,
    ).toBe(false)
  })
})

describe("evaluateFailOn — observedCount status matrix (all 8 branches)", () => {
  it("maps each FailOnStatus to the correct Summary/breakdown field", () => {
    const summary = {
      ...emptySummary(),
      added: 1,
      removed: 2,
      changed: 3,
      moved: 4,
      movedChanged: 5,
      droppedToggled: 7, // 4 to-dropped + 3 to-kept
    }
    const breakdown = { toDropped: 4, toKept: 3 }
    const observe = (status: FailOnClause["status"]) =>
      evaluateFailOn({ kind: "bare", status }, summary, breakdown).observed
    expect(observe("added")).toBe(1)
    expect(observe("removed")).toBe(2)
    expect(observe("changed")).toBe(3)
    expect(observe("moved")).toBe(4)
    expect(observe("moved+changed")).toBe(5)
    expect(observe("dropped-toggled")).toBe(7)
    expect(observe("dropped-toggled:to-dropped")).toBe(4)
    expect(observe("dropped-toggled:to-kept")).toBe(3)
  })
})

describe("evaluateFailOn — sub-status without breakdown throws", () => {
  it("refuses to silently report zero when breakdown is missing", () => {
    expect(() =>
      evaluateFailOn({ kind: "bare", status: "dropped-toggled:to-kept" }, emptySummary()),
    ).toThrow(/droppedToggledBreakdown/)
    expect(() =>
      evaluateFailOn({ kind: "bare", status: "dropped-toggled:to-dropped" }, emptySummary()),
    ).toThrow(/droppedToggledBreakdown/)
  })

  it("does NOT require breakdown for the bare dropped-toggled bucket", () => {
    const summary = { ...emptySummary(), droppedToggled: 4 }
    expect(evaluateFailOn({ kind: "bare", status: "dropped-toggled" }, summary).observed).toBe(4)
  })
})
