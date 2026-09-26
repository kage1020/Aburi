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
    $schema: "https://aburi.kage1020.com/schema/aburi.diff.v1.json",
    generator: { name: "aburi", version: "0.0.0" },
    base: { ref: "main", irSchema: "aburi.ir.v1.json" },
    head: { ref: "HEAD", irSchema: "aburi.ir.v1.json" },
    summary: overrides.summary ?? emptySummary(),
    symbols: overrides.symbols ?? [],
    components: overrides.components ?? { added: [], removed: [], changed: [] },
    dependencies: overrides.dependencies ?? { added: [], removed: [] },
    slices: overrides.slices ?? [],
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

  it.each([
    ["a trailing comma", "added,", "clause 2 of 2 is empty"],
    ["a leading comma", ",added", "clause 1 of 2 is empty"],
    ["two commas in a row", "added:>1,,removed", "clause 2 of 3 is empty"],
    ["a blank clause", "added, ,removed", "clause 2 of 3 is empty"],
  ])("rejects %s, naming the empty clause", (_, spec, reason) => {
    expect(() => parseFailOn(spec)).toThrow(`--fail-on value "${spec}" is invalid: ${reason}`)
  })

  it.each([
    ["an unknown token", "bogus", 'unknown token "bogus"'],
    [
      "an unsupported comparator",
      "changed:>=10",
      'threshold must use ">N" form (e.g. changed:>10); got ">=10"',
    ],
    [
      "a non-integer threshold",
      "changed:>abc",
      'threshold must be a non-negative integer; got "abc"',
    ],
    ["a negative threshold", "changed:>-1", 'threshold must be a non-negative integer; got "-1"'],
    [
      "a threshold with no comparator",
      "changed:5",
      'threshold must use ">N" form (e.g. changed:>10); got "5"',
    ],
    [
      "a less-than threshold",
      "changed:<5",
      'threshold must use ">N" form (e.g. changed:>10); got "<5"',
    ],
    ["a misspelt subtype", "dropped-toggled:to-kep", 'unknown token "dropped-toggled:to-kep"'],
  ])("rejects %s", (_, spec, reason) => {
    expect(() => parseFailOn(spec)).toThrow(`--fail-on value "${spec}" is invalid: ${reason}`)
  })

  it("names the whole value and the clause when there is more than one", () => {
    let caught: unknown
    try {
      parseFailOn("added,bogus,removed")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FailOnParseError)
    expect((caught as FailOnParseError).value).toBe("added,bogus,removed")
    expect((caught as FailOnParseError).message).toBe(
      '--fail-on value "added,bogus,removed" is invalid: clause 2 of 3: unknown token "bogus"',
    )
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

describe("evaluateClause — confidence-changed", () => {
  const delta = {
    apiChanged: false,
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
  }
  const diff = makeDiff({
    symbols: [
      {
        status: "changed",
        before: { id: "ts:a.ts#Foo" } as never,
        after: { id: "ts:a.ts#Foo" } as never,
        delta: { ...delta, confidenceChanged: true },
      },
      {
        status: "moved+changed",
        before: { id: "ts:a.ts#Bar" } as never,
        after: { id: "ts:b.ts#Bar" } as never,
        rationale: "git-rename",
        delta: { ...delta, confidenceChanged: true },
      },
      {
        status: "changed",
        before: { id: "ts:a.ts#Baz" } as never,
        after: { id: "ts:a.ts#Baz" } as never,
        delta: { ...delta, syntaxChanged: true },
      },
    ],
  })

  it("counts changed and moved+changed entries whose confidence moved, not older ones without the key", () => {
    const clause = parseFailOn("confidence-changed")[0]
    if (clause === undefined) throw new Error("expected clause")
    expect(evaluateClause(clause, diff).observed).toBe(2)
  })

  it("leaves the api and logic gates quiet for a confidence-only change", () => {
    expect(evaluateFailOn(parseFailOn("api-changed,logic-changed"), diff).firstTriggered).toBeNull()
  })

  it("takes a threshold", () => {
    expect(evaluateFailOn(parseFailOn("confidence-changed:>2"), diff).firstTriggered).toBeNull()
    expect(
      evaluateFailOn(parseFailOn("confidence-changed:>1"), diff).firstTriggered?.observed,
    ).toBe(2)
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
