import {
  changed,
  emptySummary,
  fp,
  makeDiff,
  makeSymbol,
  movedChanged,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { DiffResult, IR, SymbolChange, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  EXIT,
  evaluateClause,
  evaluateFailOn,
  FailOnParseError,
  formatTriggered,
  parseFailOn,
} from "../src"
import { documentWith, symbolFor } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { writeIRs } from "./workspace"

const workspace = useScratchWorkspace("fail-on")

const SYMBOL = makeSymbol({ id: "ts:src/a.ts#A", name: "A" })

function diffWith(
  symbols: SymbolChange[],
  summary: Partial<DiffResult["summary"]> = {},
): DiffResult {
  return makeDiff({ symbols, summary: { ...emptySummary(), ...summary } })
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
    const diff = diffWith(
      [changed(SYMBOL, { apiChanged: true }), changed(SYMBOL, { logicChanged: true })],
      { changed: 2 },
    )
    expect(observed("api-changed", diff)).toBe(1)
    expect(observed("logic-changed", diff)).toBe(1)
    expect(observed("syntax-changed", diff)).toBe(0)
  })

  it("counts a confidence move on changed and moved+changed entries, and on nothing older", () => {
    const diff = diffWith([
      changed(SYMBOL, { confidenceChanged: true }),
      movedChanged(SYMBOL, SYMBOL, { confidenceChanged: true }),
      changed(SYMBOL, { syntaxChanged: true }),
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
  const ALPHA = symbolFor("ts:src/a.ts#alpha")
  const BETA = symbolFor("ts:src/b.ts#beta")
  const ALPHA_EDITED = { ...ALPHA, fingerprint: fp("bbb") }
  const BASE = documentWith({ symbols: [ALPHA, BETA] })

  async function diffTo(head: IR, gate: readonly string[]) {
    const paths = await writeIRs(workspace.root, BASE, head)
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
      ...gate,
    ])
    return { code, tripped: stderr.split("\n").filter((line) => line.startsWith("--fail-on")) }
  }

  it.each([
    [["--fail-on", "changed", "--fail-on", "removed"], EXIT.GATE],
    [["--fail-on", "removed", "--fail-on", "changed"], EXIT.GATE],
    [["--fail-on", "changed,removed"], EXIT.GATE],
    [["--fail-on", "removed", "--fail-on", "added"], EXIT.SUCCESS],
  ])("gates on every clause it is given: %j over one changed Symbol exits %i", async (gate, code) => {
    const run = await diffTo(documentWith({ symbols: [ALPHA_EDITED, BETA] }), gate)
    expect(run.code).toBe(code)
    expect(run.tripped).toEqual(
      code === EXIT.GATE ? ["--fail-on changed tripped (observed: 1 changed)"] : [],
    )
  })

  it.each([
    ["changed", "removed"],
    ["removed", "changed"],
  ])("reads --fail-on %s --fail-on %s in that order, naming the first that trips", async (first, second) => {
    const run = await diffTo(documentWith({ symbols: [ALPHA_EDITED] }), [
      "--fail-on",
      first,
      "--fail-on",
      second,
    ])
    expect(run.code).toBe(EXIT.GATE)
    expect(run.tripped).toEqual([`--fail-on ${first} tripped (observed: 1 ${first})`])
  })

  const EMPTY_VALUE =
    '--fail-on value "" is invalid: expected at least one clause; an empty --fail-on value would silently disable the CI gate.'

  it.each([
    [[""], EMPTY_VALUE],
    [["", "changed"], EMPTY_VALUE],
    [["bogus", "changed"], '--fail-on value "bogus" is invalid: unknown token "bogus"'],
    [
      ["removed,", "changed"],
      '--fail-on value "removed," is invalid: clause 2 of 2 is empty; remove the extra comma or write the clause.',
    ],
  ])("refuses the values %j at exit 2, quoting the one at fault, before reading either IR", async (values, says) => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./missing.json",
      "--head",
      "./also.json",
      ...values.flatMap((value) => ["--fail-on", value]),
    ])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toBe(`${says}\n`)
  })
})
