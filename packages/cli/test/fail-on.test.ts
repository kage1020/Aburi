import type { DiffResult, Summary } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { evaluateClause, evaluateFailOn, FailOnParseError, parseFailOn } from "../src"

function emptySummary(): Summary {
  return {
    added: 0,
    removed: 0,
    moved: 0,
    movedChanged: 0,
    changed: 0,
    droppedToggled: 0,
    unchanged: 0,
    droppedAdded: 0,
    droppedRemoved: 0,
    componentsAdded: 0,
    componentsRemoved: 0,
    componentsChanged: 0,
    depsAdded: 0,
    depsRemoved: 0,
  }
}

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    $schema: "https://aburi.dev/schema/aburi.diff.v1.json",
    generator: { name: "aburi", version: "0.0.0" },
    base: { ref: "main", irSchema: "aburi.ir.v1.json" },
    head: { ref: "HEAD", irSchema: "aburi.ir.v1.json" },
    summary: overrides.summary ?? emptySummary(),
    symbols: overrides.symbols ?? [],
    components: overrides.components ?? { added: [], removed: [], changed: [] },
    dependencies: overrides.dependencies ?? { added: [], removed: [] },
  }
}

describe("parseFailOn — grammar", () => {
  it("parses a bare status", () => {
    expect(parseFailOn("changed")).toEqual([{ token: "changed", threshold: null }])
  })

  it("parses a comma-separated list", () => {
    expect(parseFailOn("added,removed,changed")).toEqual([
      { token: "added", threshold: null },
      { token: "removed", threshold: null },
      { token: "changed", threshold: null },
    ])
  })

  it("parses a threshold clause", () => {
    expect(parseFailOn("changed:>10")).toEqual([{ token: "changed", threshold: 10 }])
  })

  it("parses a direction subtype (no threshold)", () => {
    expect(parseFailOn("dropped-toggled:to-kept")).toEqual([
      { token: "dropped-toggled:to-kept", threshold: null },
    ])
  })

  it("parses a delta axis", () => {
    expect(parseFailOn("api-changed,syntax-changed")).toEqual([
      { token: "api-changed", threshold: null },
      { token: "syntax-changed", threshold: null },
    ])
  })

  it("skips empty segments (trailing comma resilience)", () => {
    expect(parseFailOn("changed,,removed,")).toEqual([
      { token: "changed", threshold: null },
      { token: "removed", threshold: null },
    ])
  })

  it("rejects unknown token", () => {
    expect(() => parseFailOn("bogus")).toThrow(FailOnParseError)
  })

  it("rejects unsupported comparator", () => {
    expect(() => parseFailOn("changed:>=10")).toThrow(FailOnParseError)
  })

  it("rejects non-integer threshold", () => {
    expect(() => parseFailOn("changed:>abc")).toThrow(FailOnParseError)
  })

  it("rejects negative threshold", () => {
    expect(() => parseFailOn("changed:>-1")).toThrow(FailOnParseError)
  })
})

describe("evaluateClause — status buckets", () => {
  it("bare status fires on observed > 0", () => {
    const diff = makeDiff({ summary: { ...emptySummary(), changed: 1 } })
    const clause = parseFailOn("changed")[0]
    if (clause === undefined) throw new Error("expected clause")
    expect(evaluateClause(clause, diff)).toEqual({ triggered: true, observed: 1 })
  })

  it("bare status does not fire on 0", () => {
    const diff = makeDiff()
    const clause = parseFailOn("changed")[0]
    if (clause === undefined) throw new Error("expected clause")
    expect(evaluateClause(clause, diff).triggered).toBe(false)
  })

  it("threshold uses strict > semantics", () => {
    const diff = makeDiff({ summary: { ...emptySummary(), changed: 10 } })
    const clause = parseFailOn("changed:>10")[0]
    if (clause === undefined) throw new Error("expected clause")
    expect(evaluateClause(clause, diff).triggered).toBe(false)
    const above = makeDiff({ summary: { ...emptySummary(), changed: 11 } })
    expect(evaluateClause(clause, above).triggered).toBe(true)
  })
})

describe("evaluateClause — delta axis", () => {
  it("counts changed entries with apiChanged=true", () => {
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 2 },
      symbols: [
        {
          status: "changed",
          before: { id: "ts:a.ts#Foo" } as never,
          after: { id: "ts:a.ts#Foo" } as never,
          delta: {
            apiChanged: true,
            logicChanged: false,
            syntaxChanged: false,
            componentChanged: false,
            visibilityChanged: false,
          },
        },
        {
          status: "changed",
          before: { id: "ts:a.ts#Bar" } as never,
          after: { id: "ts:a.ts#Bar" } as never,
          delta: {
            apiChanged: false,
            logicChanged: true,
            syntaxChanged: false,
            componentChanged: false,
            visibilityChanged: false,
          },
        },
      ],
    })
    const clause = parseFailOn("api-changed")[0]
    if (clause === undefined) throw new Error("expected clause")
    expect(evaluateClause(clause, diff).observed).toBe(1)
  })
})

describe("evaluateClause — dropped-toggled subtype", () => {
  it("counts direction-specific entries", () => {
    const diff = makeDiff({
      summary: { ...emptySummary(), droppedToggled: 2 },
      symbols: [
        {
          status: "dropped-toggled",
          direction: "to-dropped",
          before: { id: "ts:a.ts#A" } as never,
          after: { id: "ts:a.ts#A" } as never,
        },
        {
          status: "dropped-toggled",
          direction: "to-kept",
          before: { id: "ts:a.ts#B" } as never,
          after: { id: "ts:a.ts#B" } as never,
        },
      ],
    })
    const toDropped = parseFailOn("dropped-toggled:to-dropped")[0]
    const toKept = parseFailOn("dropped-toggled:to-kept")[0]
    if (toDropped === undefined || toKept === undefined) throw new Error("expected clauses")
    expect(evaluateClause(toDropped, diff).observed).toBe(1)
    expect(evaluateClause(toKept, diff).observed).toBe(1)
  })
})

describe("evaluateFailOn — first-triggered semantics", () => {
  it("returns the first clause that trips", () => {
    const diff = makeDiff({ summary: { ...emptySummary(), changed: 5, removed: 3 } })
    const clauses = parseFailOn("added,changed,removed")
    const { firstTriggered, evaluations } = evaluateFailOn(clauses, diff)
    expect(firstTriggered?.clause.token).toBe("changed")
    expect(evaluations).toHaveLength(3)
  })

  it("returns null when nothing trips", () => {
    const diff = makeDiff()
    const clauses = parseFailOn("changed,removed")
    expect(evaluateFailOn(clauses, diff).firstTriggered).toBeNull()
  })
})
