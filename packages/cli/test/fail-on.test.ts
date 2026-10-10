import { makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SymbolChange, SymbolDelta, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  EXIT,
  evaluateClause,
  evaluateFailOn,
  FailOnParseError,
  formatTriggered,
  parseFailOn,
} from "../src"
import { runCliIn } from "./run-cli"

const workspace = useScratchWorkspace("fail-on")

const SYMBOL = makeSymbol({ id: "ts:src/a.ts#A", name: "A" })

const NO_DELTA: SymbolDelta = {
  apiChanged: false,
  logicChanged: false,
  syntaxChanged: false,
  componentChanged: false,
  visibilityChanged: false,
}

function diffWith(
  symbols: SymbolChange[],
  summary: Partial<DiffResult["summary"]> = {},
): DiffResult {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.diff.v1.json",
    generator: { name: "aburi", version: "0.0.0" },
    base: { ref: "main", irSchema: "aburi.ir.v1.json" },
    head: { ref: "HEAD", irSchema: "aburi.ir.v1.json" },
    summary: {
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
      ...summary,
    },
    symbols,
    components: { added: [], removed: [], changed: [] },
    dependencies: { added: [], removed: [] },
    slices: [],
  }
}

function changed(delta: Partial<SymbolDelta>): SymbolChange {
  return { status: "changed", before: SYMBOL, after: SYMBOL, delta: { ...NO_DELTA, ...delta } }
}

function evaluation(spec: string, diff: DiffResult) {
  const [clause] = parseFailOn(spec)
  if (clause === undefined) throw new Error(`no clause in ${spec}`)
  return evaluateClause(clause, diff)
}

function observed(spec: string, diff: DiffResult): number {
  return evaluation(spec, diff).observed
}

describe("parseFailOn — the grammar", () => {
  it.each([
    ["changed", [{ token: "changed", threshold: null }]],
    [
      "added,removed,changed",
      [
        { token: "added", threshold: null },
        { token: "removed", threshold: null },
        { token: "changed", threshold: null },
      ],
    ],
    ["changed:>10", [{ token: "changed", threshold: 10 }]],
    ["dropped-toggled:to-kept", [{ token: "dropped-toggled:to-kept", threshold: null }]],
    ["dropped-toggled:to-kept:>3", [{ token: "dropped-toggled:to-kept", threshold: 3 }]],
    [
      "api-changed, syntax-changed",
      [
        { token: "api-changed", threshold: null },
        { token: "syntax-changed", threshold: null },
      ],
    ],
  ])("reads %s", (spec, clauses) => {
    expect(parseFailOn(spec)).toEqual(clauses)
  })

  it.each([
    [
      "an empty string",
      "",
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    ],
    [
      "a single comma",
      ",",
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    ],
    [
      "a comma-only value",
      ",,",
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    ],
    [
      "a trailing comma",
      "added,",
      "clause 2 of 2 is empty; remove the extra comma or write the clause.",
    ],
    ["a leading comma", ",added", "clause 1 of 2 is empty"],
    ["two commas in a row", "added:>1,,removed", "clause 2 of 3 is empty"],
    ["a blank clause", "added, ,removed", "clause 2 of 3 is empty"],
    ["an unknown token", "bogus", 'unknown token "bogus"'],
    [
      "an unknown token among others",
      "added,bogus,removed",
      'clause 2 of 3: unknown token "bogus"',
    ],
    [
      "an unsupported comparator",
      "changed:>=10",
      'threshold must use ">N" form (e.g. changed:>10); got ">=10"',
    ],
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
    [
      "a non-integer threshold",
      "changed:>abc",
      'threshold must be a non-negative integer; got "abc"',
    ],
    ["a negative threshold", "changed:>-1", 'threshold must be a non-negative integer; got "-1"'],
    ["a misspelt subtype", "dropped-toggled:to-kep", 'unknown token "dropped-toggled:to-kep"'],
  ])("refuses %s, quoting the whole value", (_, spec, reason) => {
    const parse = () => parseFailOn(spec)
    expect(parse).toThrow(FailOnParseError)
    expect(parse).toThrow(`--fail-on value "${spec}" is invalid: ${reason}`)
  })
})

describe("evaluateClause — what a clause counts", () => {
  it.each([
    ["changed", diffWith([], { changed: 1 }), { triggered: true, observed: 1 }],
    ["changed", diffWith([]), { triggered: false, observed: 0 }],
    ["changed:>10", diffWith([], { changed: 10 }), { triggered: false, observed: 10 }],
    ["changed:>10", diffWith([], { changed: 11 }), { triggered: true, observed: 11 }],
  ])("%s over a diff with %j changed", (spec, diff, expected) => {
    expect(evaluation(spec, diff)).toEqual(expected)
  })

  it("counts the changes whose delta moved the axis, and only those", () => {
    const diff = diffWith([changed({ apiChanged: true }), changed({ logicChanged: true })], {
      changed: 2,
    })
    expect(observed("api-changed", diff)).toBe(1)
    expect(observed("logic-changed", diff)).toBe(1)
    expect(observed("syntax-changed", diff)).toBe(0)
  })

  it("counts a confidence move on changed and moved+changed entries, and on nothing older", () => {
    const diff = diffWith([
      changed({ confidenceChanged: true }),
      {
        status: "moved+changed",
        before: SYMBOL,
        after: SYMBOL,
        rationale: "git-rename",
        delta: { ...NO_DELTA, confidenceChanged: true },
      },
      changed({ syntaxChanged: true }),
    ])
    expect(observed("confidence-changed", diff)).toBe(2)
    expect(evaluateFailOn(parseFailOn("api-changed,logic-changed"), diff).firstTriggered).toBeNull()
    expect(evaluateFailOn(parseFailOn("confidence-changed:>2"), diff).firstTriggered).toBeNull()
  })

  it("counts each dropped-toggled direction apart", () => {
    const diff = diffWith(
      [
        { status: "dropped-toggled", direction: "to-dropped", before: SYMBOL, after: SYMBOL },
        { status: "dropped-toggled", direction: "to-kept", before: SYMBOL, after: SYMBOL },
        { status: "dropped-toggled", direction: "to-kept", before: SYMBOL, after: SYMBOL },
      ],
      { droppedToggled: 3 },
    )
    expect(observed("dropped-toggled", diff)).toBe(3)
    expect(observed("dropped-toggled:to-dropped", diff)).toBe(1)
    expect(observed("dropped-toggled:to-kept", diff)).toBe(2)
  })

  it("counts unknown off the entries, so a diff written before the counter answers the same", () => {
    const unknown: SymbolUnknown = {
      status: "unknown",
      symbol: SYMBOL,
      absentFrom: "head",
      reason: "parse-failed",
    }
    expect(observed("unknown", diffWith([unknown, unknown]))).toBe(2)
  })
})

describe("evaluateFailOn — which clause trips", () => {
  it("returns the first clause that trips, and every clause's count", () => {
    const diff = diffWith([], { changed: 5, removed: 3 })
    const { firstTriggered, evaluations } = evaluateFailOn(
      parseFailOn("added,changed,removed"),
      diff,
    )
    expect(firstTriggered).toEqual({ clause: { token: "changed", threshold: null }, observed: 5 })
    expect(evaluations.map((e) => [e.clause.token, e.observed, e.triggered])).toEqual([
      ["added", 0, false],
      ["changed", 5, true],
      ["removed", 3, true],
    ])
  })

  it("returns null when nothing trips", () => {
    expect(evaluateFailOn(parseFailOn("changed,removed"), diffWith([])).firstTriggered).toBeNull()
  })

  it.each([
    [{ token: "changed", threshold: null }, 4, "--fail-on changed tripped (observed: 4 changed)"],
    [
      { token: "removed", threshold: 10 },
      12,
      "--fail-on removed:>10 tripped (observed: 12 removed)",
    ],
  ] as const)("phrases %j tripping on %i", (clause, count, line) => {
    expect(formatTriggered(clause, count)).toBe(line)
  })
})

describe("aburi diff --fail-on", () => {
  it("refuses a value with no clause at exit 2, before reading either IR", async () => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./missing.json",
      "--head",
      "./also.json",
      "--fail-on",
      "",
    ])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain('--fail-on value "" is invalid: expected at least one clause')
  })
})
