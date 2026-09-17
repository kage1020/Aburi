import { describe, expect, it } from "vitest"
import {
  evaluateFailOn,
  FAIL_ON_STATUSES,
  type FailOnClause,
  type FailOnComparator,
  type FailOnStatus,
  formatFailOnClause,
  formatFailOnTriggered,
} from "../src"
import { emptySummary } from "./fixtures"

describe("formatFailOnClause", () => {
  it("emits bare status for clauses with no threshold", () => {
    expect(formatFailOnClause({ kind: "bare", status: "changed" })).toBe("changed")
    expect(formatFailOnClause({ kind: "bare", status: "dropped-toggled" })).toBe("dropped-toggled")
    expect(formatFailOnClause({ kind: "bare", status: "dropped-toggled:to-kept" })).toBe(
      "dropped-toggled:to-kept",
    )
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
  const triggered = (comparator: FailOnComparator, count: number, observed: number) =>
    evaluateFailOn(
      { kind: "threshold", status: "changed", comparator, count },
      observedAt(observed),
    ).triggered

  it.each<[FailOnComparator, number, number, boolean]>([
    [">", 10, 10, false],
    [">", 10, 11, true],
    [">=", 10, 10, true],
    [">=", 10, 9, false],
    ["==", 5, 5, true],
    ["==", 5, 4, false],
    ["==", 5, 6, false],
    ["<=", 5, 5, true],
    ["<=", 5, 6, false],
  ])("`changed:%s%i` with %i observed → %s", (comparator, count, observed, expected) => {
    expect(triggered(comparator, count, observed)).toBe(expected)
  })
})

describe("evaluateFailOn — observedCount status matrix", () => {
  const summary = {
    ...emptySummary(),
    added: 1,
    removed: 2,
    changed: 3,
    moved: 4,
    movedChanged: 5,
    droppedToggled: 7, // 4 to-dropped + 3 to-kept
    unknown: 9,
  }
  const breakdown = { toDropped: 4, toKept: 3 }
  const observe = (status: FailOnClause["status"]) =>
    evaluateFailOn({ kind: "bare", status }, summary, breakdown).observed

  // Keyed by the exported union rather than listed by hand: a matrix written out longhand
  // does not break when the union grows, which is how this test came to be named "all 8
  // branches" while the switch it covers had nine.
  const expected: Record<FailOnStatus, number> = {
    added: 1,
    removed: 2,
    changed: 3,
    moved: 4,
    "moved+changed": 5,
    "dropped-toggled": 7,
    "dropped-toggled:to-dropped": 4,
    "dropped-toggled:to-kept": 3,
    unknown: 9,
  }

  it.each(FAIL_ON_STATUSES)("maps %s to the right field", (status) => {
    expect(observe(status)).toBe(expected[status])
  })

  it("reports zero unknowns for a diff written before the counter existed", () => {
    // Absence is a writer that predates the field, not an assertion that there were none —
    // but a gate must not fail a document that cannot answer, so zero is the answer here.
    const { unknown: _dropped, ...older } = summary
    expect(evaluateFailOn({ kind: "bare", status: "unknown" }, older, breakdown).observed).toBe(0)
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
