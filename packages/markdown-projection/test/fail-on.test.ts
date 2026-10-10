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
  it.each<FailOnStatus>([
    "changed",
    "dropped-toggled",
    "dropped-toggled:to-kept",
  ])("writes a bare %s clause as the status alone", (status) => {
    expect(formatFailOnClause({ kind: "bare", status })).toBe(status)
  })

  it.each<[FailOnComparator, string]>([
    [">", "changed:>10"],
    [">=", "changed:>=10"],
    ["==", "changed:==10"],
    ["<=", "changed:<=10"],
  ])("writes a %s threshold as `status:<comparator><count>`", (comparator, written) => {
    expect(
      formatFailOnClause({ kind: "threshold", status: "changed", comparator, count: 10 }),
    ).toBe(written)
  })
})

describe("formatFailOnTriggered", () => {
  it("quotes the clause and the observed count", () => {
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

  it("quotes a bare clause the same way", () => {
    expect(formatFailOnTriggered({ kind: "bare", status: "dropped-toggled" }, 3)).toBe(
      "--fail-on dropped-toggled tripped (observed: 3 dropped-toggled symbols)",
    )
  })
})

describe("evaluateFailOn — a bare clause", () => {
  it.each([
    [1, true],
    [0, false],
  ])("with %i observed fires: %s", (observed, triggered) => {
    expect(
      evaluateFailOn({ kind: "bare", status: "changed" }, { ...emptySummary(), changed: observed }),
    ).toEqual({ triggered, observed })
  })
})

describe("evaluateFailOn — a threshold clause", () => {
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
  ])("`changed:%s%i` with %i observed fires: %s", (comparator, count, observed, expected) => {
    const summary = { ...emptySummary(), changed: observed }
    expect(
      evaluateFailOn({ kind: "threshold", status: "changed", comparator, count }, summary)
        .triggered,
    ).toBe(expected)
  })
})

describe("evaluateFailOn — the count each status watches", () => {
  const summary = {
    ...emptySummary(),
    added: 1,
    removed: 2,
    changed: 3,
    moved: 4,
    movedChanged: 5,
    droppedToggled: 7,
    unknown: 9,
  }
  const breakdown = { toDropped: 4, toKept: 3 }

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

  it.each(FAIL_ON_STATUSES)("reads %s from its own counter", (status) => {
    expect(evaluateFailOn({ kind: "bare", status }, summary, breakdown).observed).toBe(
      expected[status],
    )
  })

  it("reports zero unknowns for a diff written before the counter existed", () => {
    const { unknown: _dropped, ...older } = summary
    expect(evaluateFailOn({ kind: "bare", status: "unknown" }, older, breakdown).observed).toBe(0)
  })

  it.each<FailOnStatus>([
    "dropped-toggled:to-kept",
    "dropped-toggled:to-dropped",
  ])("refuses %s without a breakdown rather than report zero", (status) => {
    expect(() => evaluateFailOn({ kind: "bare", status }, emptySummary())).toThrow(
      /droppedToggledBreakdown/,
    )
  })

  it("needs no breakdown for the bare dropped-toggled count", () => {
    const counted = { ...emptySummary(), droppedToggled: 4 }
    expect(evaluateFailOn({ kind: "bare", status: "dropped-toggled" }, counted).observed).toBe(4)
  })
})
