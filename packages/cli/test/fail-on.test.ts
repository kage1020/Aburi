import {
  changed,
  emptySummary,
  fp,
  makeDiff,
  makeSymbol,
  movedChanged,
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
  type FailOnScope,
  formatTriggered,
  parseFailOn,
} from "../src"
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

function removedEntry(name: string, fold: Pick<SymbolRemoved, "foldedInto"> = {}): SymbolRemoved {
  return { status: "removed", symbol: makeSymbol({ id: `ts:src/a.ts#${name}`, name }), ...fold }
}

const FOLDED = { foldedInto: symbolId("ts:src/fixtures.ts#emptyIR") }
const BARE = { foldedInto: null }

function evaluation(spec: string, diff: DiffResult, scope?: FailOnScope) {
  const [clause] = parseFailOn(spec)
  if (clause === undefined) throw new Error(`no clause in ${spec}`)
  return evaluateClause(clause, diff, scope)
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

  it("leaves a removal folded into a head Symbol to removed:folded", () => {
    const diff = diffWith([
      removedEntry("bare", BARE),
      removedEntry("folded", FOLDED),
      removedEntry("written-before-folds"),
    ])
    expect(evaluation("removed", diff).symbols).toEqual([
      "ts:src/a.ts#bare",
      "ts:src/a.ts#written-before-folds",
    ])
    expect(evaluation("removed:folded", diff).symbols).toEqual(["ts:src/a.ts#folded"])
    expect(
      evaluateFailOn(parseFailOn("removed"), diffWith([removedEntry("folded", FOLDED)]))
        .firstTriggered,
    ).toBeNull()
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

describe("evaluateClause — the non-test scope", () => {
  const inTest = (file: string, name: string) =>
    makeSymbol({ id: `ts:${file}#${name}`, name, inTestFile: true })
  const outside = (file: string, name: string) => makeSymbol({ id: `ts:${file}#${name}`, name })

  it("leaves out the entries of test files, judging a pair by its head", () => {
    const diff = diffWith([
      { status: "removed", symbol: inTest("src/a.test.ts", "fixture") },
      removedEntry("gone", BARE),
      movedChanged(inTest("src/a.test.ts", "parse"), outside("src/parse.ts", "parse"), {
        apiChanged: true,
      }),
      movedChanged(outside("src/b.ts", "mock"), inTest("test/mock.ts", "mock"), {
        apiChanged: true,
      }),
    ])
    expect(evaluation("removed", diff, "non-test").symbols).toEqual(["ts:src/a.ts#gone"])
    expect(evaluation("api-changed", diff, "non-test").symbols).toEqual(["ts:src/parse.ts#parse"])
    expect(evaluation("removed", diff).observed).toBe(2)
    expect(evaluation("api-changed", diff, "all").observed).toBe(2)
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
      scope: "all",
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
    [{ token: "changed", threshold: null }, 4, "--fail-on changed tripped (observed: 4 changed)"],
    [
      { token: "removed", threshold: 10 },
      12,
      "--fail-on removed:>10 tripped (observed: 12 removed)",
    ],
  ] as const)("phrases %j tripping on %i", (clause, count, line) => {
    expect(formatTriggered(clause, count)).toBe(line)
  })

  it("says when it counted outside test files alone", () => {
    expect(formatTriggered({ token: "removed", threshold: null }, 2, [], "non-test")).toBe(
      "--fail-on removed tripped (observed: 2 removed outside test files)",
    )
  })

  it.each([
    [1, ["--fail-on removed tripped (observed: 1 removed)", "  ts:src/a.ts#f0"]],
    [
      12,
      [
        "--fail-on removed tripped (observed: 12 removed)",
        ...Array.from({ length: 10 }, (_, i) => `  ts:src/a.ts#f${i}`),
        "  … and 2 more",
      ],
    ],
  ])("names the Symbols under the line, ten at most, for %i of them", (count, lines) => {
    const ids = Array.from({ length: count }, (_, i) => symbolId(`ts:src/a.ts#f${i}`))
    expect(formatTriggered({ token: "removed", threshold: null }, count, ids).split("\n")).toEqual(
      lines,
    )
  })
})

describe("aburi diff --fail-on", () => {
  const ALPHA = symbolFor("ts:src/a.ts#alpha")
  const BETA = symbolFor("ts:src/b.ts#beta")
  const ALPHA_EDITED = { ...ALPHA, fingerprint: fp("bbb") }
  const BASE = documentWith({ symbols: [ALPHA, BETA] })

  async function diffTo(head: IR, gate: readonly string[], base = BASE) {
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

  describe("under --fail-on-scope", () => {
    const FIXTURE = { ...symbolFor("ts:src/a.test.ts#fixture"), inTestFile: true as const }
    const WITH_FIXTURE = documentWith({ symbols: [ALPHA, BETA, FIXTURE] })

    const FIXTURE_GONE = documentWith({ symbols: [ALPHA, BETA] })
    const BOTH_GONE = documentWith({ symbols: [ALPHA] })

    it.each<[string, string, IR, ExitCode, string[]]>([
      ["non-test", "a removed fixture", FIXTURE_GONE, EXIT.SUCCESS, []],
      [
        "all",
        "a removed fixture",
        FIXTURE_GONE,
        EXIT.GATE,
        ["--fail-on removed tripped (observed: 1 removed)"],
      ],
      [
        "non-test",
        "a removed fixture and a removed Symbol beside it",
        BOTH_GONE,
        EXIT.GATE,
        ["--fail-on removed tripped (observed: 1 removed outside test files)"],
      ],
    ])("%s, over %s, exits %i and prints %j", async (scope, _over, head, code, tripped) => {
      const run = await diffTo(
        head,
        ["--fail-on", "removed", "--fail-on-scope", scope],
        WITH_FIXTURE,
      )
      expect({ code: run.code, tripped: run.tripped }).toEqual({ code, tripped })
    })

    it("names only the Symbols it counted", async () => {
      const run = await diffTo(
        BOTH_GONE,
        ["--fail-on", "removed", "--fail-on-scope", "non-test"],
        WITH_FIXTURE,
      )
      expect(run.stderr).toContain(
        "--fail-on removed tripped (observed: 1 removed outside test files)\n  ts:src/b.ts#beta\n",
      )
      expect(run.stderr).not.toContain("fixture")
    })

    it("refuses a scope it does not know at exit 2", async () => {
      const { code, stderr } = await runCliIn(workspace.root, [
        "diff",
        "--base",
        "./missing.json",
        "--head",
        "./also.json",
        "--fail-on-scope",
        "tests",
      ])
      expect(code).toBe(EXIT.INPUT_ERROR)
      expect(stderr).toContain("--fail-on-scope must be one of: all | non-test")
    })
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
