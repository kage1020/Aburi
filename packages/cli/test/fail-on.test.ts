import {
  changed,
  emptySummary,
  fp,
  makeDiff,
  makeSymbol,
  movedChanged,
  rule,
  symbolId,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { DiffResult, IR, SymbolChange, SymbolRemoved, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  EXIT,
  type ExitCode,
  evaluateClause,
  evaluateFailOn,
  FailOnParseError,
  formatTriggered,
  parseFailOn,
} from "../src"
import { uncountedDuplicates } from "../src/fail-on"
import { documentWith, symbolFor } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { filesUnder, writeEarlierReports, writeIRs } from "./workspace"

const workspace = useScratchWorkspace("fail-on")

const SYMBOL = makeSymbol({ id: "ts:src/a.ts#A", name: "A" })

function diffWith(symbols: SymbolChange[]): DiffResult {
  return makeDiff({ symbols, summary: emptySummary() })
}

function changedEntries(count: number): SymbolChange[] {
  return Array.from({ length: count }, (_, i) =>
    changed(makeSymbol({ id: `ts:src/a.ts#f${i}`, name: `f${i}` })),
  )
}

function removedEntry(
  name: string,
  duplicate: Pick<SymbolRemoved, "duplicateOf"> = {},
): SymbolRemoved {
  return {
    status: "removed",
    symbol: makeSymbol({ id: `ts:src/a.ts#${name}`, name }),
    ...duplicate,
  }
}

const DUPLICATE = { duplicateOf: symbolId("ts:src/fixtures.ts#emptyIR") }
const BARE = { duplicateOf: null }

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
    ["removed:duplicate:>2", [{ token: "removed:duplicate", threshold: 2 }]],
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
    ["changed", 1, true],
    ["changed", 0, false],
    ["changed:>10", 10, false],
    ["changed:>10", 11, true],
  ])("%s over %i changed entries", (spec, count, triggered) => {
    expect(evaluation(spec, diffWith(changedEntries(count)))).toMatchObject({
      triggered,
      observed: count,
    })
  })

  it("names each entry it counted by the id the head gives it, in the diff's order", () => {
    const moved = movedChanged(
      makeSymbol({ id: "ts:src/old.ts#f", name: "f" }),
      makeSymbol({ id: "ts:src/new.ts#f", name: "f" }),
      { apiChanged: true },
    )
    const diff = diffWith([removedEntry("gone"), moved, changed(SYMBOL, { apiChanged: true })])
    expect(evaluation("api-changed", diff).symbols).toEqual(["ts:src/new.ts#f", "ts:src/a.ts#A"])
    expect(evaluation("removed", diff).symbols).toEqual(["ts:src/a.ts#gone"])
  })

  it("leaves a removed duplicate of a head Symbol to removed:duplicate", () => {
    const diff = diffWith([
      removedEntry("bare", BARE),
      removedEntry("duplicate", DUPLICATE),
      removedEntry("written-before-duplicates"),
    ])
    expect(evaluation("removed", diff).symbols).toEqual([
      "ts:src/a.ts#bare",
      "ts:src/a.ts#written-before-duplicates",
    ])
    expect(evaluation("removed:duplicate", diff).symbols).toEqual(["ts:src/a.ts#duplicate"])
    expect(
      evaluateFailOn(parseFailOn("removed"), diffWith([removedEntry("duplicate", DUPLICATE)]))
        .firstTriggered,
    ).toBeNull()
  })

  it.each([
    ["removed", ["ts:src/a.ts#duplicate"]],
    ["removed:>3", ["ts:src/a.ts#duplicate"]],
    ["changed,removed", ["ts:src/a.ts#duplicate"]],
    ["removed,removed:duplicate", []],
    ["removed:duplicate:>3", []],
    ["changed", []],
  ])("under %s, leaves uncounted the duplicates %j", (spec, ids) => {
    const diff = diffWith([removedEntry("bare", BARE), removedEntry("duplicate", DUPLICATE)])
    expect(uncountedDuplicates(parseFailOn(spec), diff)).toEqual(ids)
  })

  it("counts the changes whose delta moved the axis, and only those", () => {
    const diff = diffWith([
      changed(SYMBOL, { apiChanged: true }),
      changed(SYMBOL, { logicChanged: true }),
    ])
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
    const diff = diffWith([
      { status: "dropped-toggled", direction: "to-dropped", before: SYMBOL, after: SYMBOL },
      { status: "dropped-toggled", direction: "to-kept", before: SYMBOL, after: SYMBOL },
      { status: "dropped-toggled", direction: "to-kept", before: SYMBOL, after: SYMBOL },
    ])
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
    const diff = diffWith([...changedEntries(2), removedEntry("gone", BARE)])
    const { firstTriggered, evaluations } = evaluateFailOn(
      parseFailOn("added,changed,removed"),
      diff,
    )
    expect(firstTriggered).toEqual({
      clause: { token: "changed", threshold: null },
      observed: 2,
      symbols: ["ts:src/a.ts#f0", "ts:src/a.ts#f1"],
    })
    expect(evaluations.map((e) => [e.clause.token, e.observed, e.triggered])).toEqual([
      ["added", 0, false],
      ["changed", 2, true],
      ["removed", 1, true],
    ])
  })

  it("returns null when nothing trips", () => {
    expect(evaluateFailOn(parseFailOn("changed,removed"), diffWith([])).firstTriggered).toBeNull()
  })

  it.each([
    [{ token: "changed", threshold: null }, "--fail-on changed tripped (observed: 1 changed)"],
    [{ token: "removed", threshold: 10 }, "--fail-on removed:>10 tripped (observed: 1 removed)"],
  ] as const)("phrases %j tripping", (clause, line) => {
    const [first] = formatTriggered({ clause, observed: 1, symbols: [SYMBOL.id] }).split("\n")
    expect(first).toBe(line)
  })

  const ids = (count: number) =>
    Array.from({ length: count }, (_, i) => symbolId(`ts:src/a.ts#f${i}`))
  const named = (count: number) => ids(count).map((id) => `  ${id}`)

  it.each([
    [1, named(1)],
    [10, named(10)],
    [11, [...named(10), "  … and 1 more"]],
    [12, [...named(10), "  … and 2 more"]],
  ])("names the Symbols under the line, ten at most, for %i of them", (count, lines) => {
    const clause = { token: "removed", threshold: null } as const
    expect(formatTriggered({ clause, observed: count, symbols: ids(count) }).split("\n")).toEqual([
      `--fail-on removed tripped (observed: ${count} removed)`,
      ...lines,
    ])
  })
})

describe("aburi diff --fail-on", () => {
  const ALPHA = symbolFor("ts:src/a.ts#alpha")
  const BETA = symbolFor("ts:src/b.ts#beta")
  const ALPHA_EDITED = { ...ALPHA, fingerprint: fp("bbb") }
  const BASE = documentWith({ symbols: [ALPHA, BETA] })

  async function diffTo(head: IR, gate: readonly string[], base: IR = BASE) {
    const paths = await writeIRs(workspace.root, base, head)
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
      ...gate,
    ])
    return {
      code,
      tripped: stderr.split("\n").filter((line) => line.startsWith("--fail-on")),
      stderr,
    }
  }

  const CHANGED_TRIPPED = "--fail-on changed tripped (observed: 1 changed)"

  it.each<[string[], ExitCode, string[]]>([
    [["--fail-on", "changed", "--fail-on", "removed"], EXIT.GATE, [CHANGED_TRIPPED]],
    [["--fail-on", "removed", "--fail-on", "changed"], EXIT.GATE, [CHANGED_TRIPPED]],
    [["--fail-on", "changed,removed"], EXIT.GATE, [CHANGED_TRIPPED]],
    [["--fail-on", "removed", "--fail-on", "added"], EXIT.SUCCESS, []],
    [[], EXIT.SUCCESS, []],
  ])("gates on every clause it is given: %j over one changed Symbol exits %i and prints %j", async (gate, code, tripped) => {
    const run = await diffTo(documentWith({ symbols: [ALPHA_EDITED, BETA] }), gate)
    expect({ code: run.code, tripped: run.tripped }).toEqual({ code, tripped })
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

  it("names the Symbols that tripped it under the line, on stderr", async () => {
    const run = await diffTo(documentWith({ symbols: [ALPHA] }), ["--fail-on", "removed"])
    expect(run.code).toBe(EXIT.GATE)
    expect(run.stderr).toContain(
      "--fail-on removed tripped (observed: 1 removed)\n  ts:src/b.ts#beta\n",
    )
  })

  const TWIN = {
    fingerprint: fp("twin"),
    rules: [rule({ type: "return", expr: "{ symbols: [] }", line: 2 })],
  }
  const KEPT = { ...symbolFor("ts:src/a.ts#emptyIR"), ...TWIN }
  const DUPLICATE_OF_KEPT = { ...symbolFor("ts:src/b.ts#makeEmptyIR"), ...TWIN }
  const UNCOUNTED =
    "⚠ --fail-on removed did not count 1 removal(s) of a duplicate whose body a head Symbol holds (removed:duplicate counts them): ts:src/b.ts#makeEmptyIR."

  it.each<[string, ExitCode, string[], boolean]>([
    ["removed", EXIT.SUCCESS, [], true],
    [
      "removed:duplicate",
      EXIT.GATE,
      [
        "--fail-on removed:duplicate tripped (observed: 1 removed:duplicate)",
        "  ts:src/b.ts#makeEmptyIR",
      ],
      false,
    ],
  ])("reads a removed duplicate of a head Symbol under --fail-on %s: exit %i", async (gate, code, tripped, noted) => {
    const run = await diffTo(
      documentWith({ symbols: [KEPT] }),
      ["--fail-on", gate],
      documentWith({ symbols: [KEPT, DUPLICATE_OF_KEPT] }),
    )
    const lines = run.stderr.split("\n")
    const trippedAt = lines.findIndex((line) => line.startsWith("--fail-on"))
    expect({
      code: run.code,
      tripped: trippedAt === -1 ? [] : lines.slice(trippedAt, trippedAt + 2),
      noted: lines.includes(UNCOUNTED),
    }).toEqual({ code, tripped, noted })
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
  ])("refuses the values %j at exit 2, quoting the one at fault, before it reads either IR or removes an earlier report", async (values, says) => {
    const earlier = await writeEarlierReports(workspace.root, ["out"])
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
    expect(await filesUnder(workspace.root)).toEqual(earlier)
  })
})
