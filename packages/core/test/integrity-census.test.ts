import { makeIR } from "@aburi/test-support"
import type { CallResolutionStats, IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../src/index"
import { makeSymbol } from "./fixtures/ir"

function irWithOneUnresolvedCall(callResolution?: CallResolutionStats): IR {
  const ir = makeIR({
    symbols: [
      makeSymbol("ts:src/a.ts#caller", { calls: [{ target: "typoed", line: 1, resolved: null }] }),
    ],
  })
  if (callResolution !== undefined) ir.stats.callResolution = callResolution
  return ir
}

function census(totalCalls: number, resolvedCalls: number, noMatch: number): CallResolutionStats {
  return {
    totalCalls,
    resolvedCalls,
    unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch },
  }
}

describe("checkIRIntegrity — callResolution census", () => {
  it("accepts a census that matches symbols[]", () => {
    expect(checkIRIntegrity(irWithOneUnresolvedCall(census(1, 0, 1)))).toEqual([])
  })

  it("stays silent when the Document carries no census", () => {
    expect(checkIRIntegrity(irWithOneUnresolvedCall())).toEqual([])
  })

  it.each<[string, CallResolutionStats, string]>([
    [
      "a totalCalls that disagrees with symbols[]",
      census(7, 0, 7),
      "stats.callResolution.totalCalls",
    ],
    [
      "a resolvedCalls that disagrees with symbols[]",
      census(1, 1, 0),
      "stats.callResolution.resolvedCalls",
    ],
    [
      "buckets that do not sum to the unresolved remainder",
      census(1, 0, 0),
      "stats.callResolution.unresolved",
    ],
  ])("flags %s", (_what, stats, subject) => {
    const violations = checkIRIntegrity(irWithOneUnresolvedCall(stats))
    expect(violations.filter((v) => v.invariant === 15).map((v) => v.subject)).toEqual([subject])
  })
})

type SkippedFiles = NonNullable<IR["stats"]["skippedFiles"]>

/** A Document that found three files and parsed one, unless `stats` says otherwise. */
function documentWith(stats: Partial<IR["stats"]>): IR {
  const ir = makeIR()
  ir.stats = { ...ir.stats, totalFiles: 3, parsedFiles: 1, ...stats }
  return ir
}

function censusViolations(ir: IR): string[] {
  return checkIRIntegrity(ir)
    .filter((violation) => violation.invariant === 21)
    .map((violation) => violation.message)
}

function invariantsBroken(skippedFiles: SkippedFiles): number[] {
  return checkIRIntegrity(documentWith({ totalFiles: 2, parsedFiles: 0, skippedFiles })).map(
    (violation) => violation.invariant,
  )
}

describe("checkIRIntegrity — skippedFiles census", () => {
  it.each<[string, Partial<IR["stats"]>]>([
    [
      "one entry per file found and not parsed",
      {
        skippedFiles: [
          { path: "a.stub", reason: "over-size" },
          { path: "b.stub", reason: "parse-failed" },
        ],
      },
    ],
    ["no list at all, however many files went unparsed", {}],
    ["no list when every file found was parsed", { totalFiles: 2, parsedFiles: 2 }],
  ])("accepts %s", (_label, stats) => {
    expect(censusViolations(documentWith(stats))).toEqual([])
  })

  it.each<[string, Partial<IR["stats"]>, string]>([
    [
      "a file missing from the list",
      { skippedFiles: [{ path: "a.stub", reason: "over-size" }] },
      "names 1 file(s) but totalFiles - parsedFiles is 2",
    ],
    [
      "a file named twice",
      {
        skippedFiles: [
          { path: "a.stub", reason: "over-size" },
          { path: "a.stub", reason: "parse-failed" },
        ],
      },
      "more than once",
    ],
    [
      "more files parsed than found",
      { totalFiles: 1, parsedFiles: 2 },
      "cannot parse more files than it found",
    ],
  ])("refuses %s", (_label, stats, message) => {
    expect(censusViolations(documentWith(stats))).toEqual([expect.stringContaining(message)])
  })

  it("reports both faults when a list sits beside more files parsed than found", () => {
    const ir = documentWith({
      totalFiles: 1,
      parsedFiles: 2,
      skippedFiles: [{ path: "a.stub", reason: "over-size" }],
    })
    expect(censusViolations(ir)).toHaveLength(2)
  })

  it.each<[string, SkippedFiles, number]>([
    [
      "out of path order",
      [
        { path: "b.stub", reason: "over-size" },
        { path: "a.stub", reason: "parse-failed" },
      ],
      11,
    ],
    [
      "absolute",
      [
        { path: "/abs/a.stub", reason: "over-size" },
        { path: "b.stub", reason: "parse-failed" },
      ],
      10,
    ],
    [
      "not in NFC",
      [
        { path: "cafe\u0301.stub", reason: "over-size" },
        { path: "z.stub", reason: "parse-failed" },
      ],
      19,
    ],
  ])("holds the paths to the rule every path-bearing array obeys: refuses them %s", (_label, list, invariant) => {
    expect(invariantsBroken(list)).toContain(invariant)
  })
})
