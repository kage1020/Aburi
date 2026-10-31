import {
  changed,
  dependency,
  makeDiff,
  makeSymbol,
  moved,
  movedChanged,
  sliceOf,
  symbolAt,
  symbolId,
  withCallsTo,
} from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { namedSymbol, projectChanges, relocated } from "./fixtures"
import { bytes, headings, noteOf, sectionOf } from "./markdown"

const HEADING = "## 🧪 Test files"

function fixture(name: string): IRSymbol {
  return makeSymbol({ id: `ts:src/${name}.test.ts#${name}`, name, inTestFile: true })
}

function movedTo(symbol: IRSymbol, file: string, inTestFile: boolean): IRSymbol {
  const { inTestFile: _, ...rest } = relocated(symbol, file)
  return inTestFile ? { ...rest, inTestFile } : rest
}

describe("projectDiff — the changes of test files", () => {
  const scratch = fixture("scratch")
  const helper = fixture("helper")
  const md = projectChanges([
    { status: "added", symbol: fixture("mock") },
    { status: "added", symbol: fixture("builder") },
    { status: "added", symbol: namedSymbol("order") },
    { status: "removed", symbol: fixture("stale") },
    changed(fixture("apiHelper"), { apiChanged: true }),
    changed(fixture("logicHelper"), { logicChanged: true, syntaxChanged: true }),
    changed(fixture("formatted"), { syntaxChanged: true }),
    movedChanged(helper, movedTo(helper, "test/helper.ts", true), { logicChanged: true }),
    moved(scratch, movedTo(scratch, "test/scratch.ts", true)),
  ])

  it("are folded into the last section, by name, in the order of the sections above it", () => {
    expect(headings(md)).toEqual(["## ➕ Added", HEADING])
    expect(sectionOf(md, HEADING)).toEqual([
      HEADING,
      "",
      "<details>",
      "<summary>8 symbols in test files</summary>",
      "",
      "**1 API change**",
      "- `apiHelper` *(function)* — `src/apiHelper.test.ts:1`",
      "",
      "**1 logic change**",
      "- `logicHelper` *(function)* — `src/logicHelper.test.ts:1`",
      "",
      "**2 added**",
      "- `builder` *(function)* — `src/builder.test.ts:1`",
      "- `mock` *(function)* — `src/mock.test.ts:1`",
      "",
      "**1 removed**",
      "- `stale` *(function)* — `src/stale.test.ts:1`",
      "",
      "**1 moved + changed**",
      "- `helper` *(function)* — `test/helper.ts:1` (from `src/helper.test.ts`)",
      "",
      "**1 moved**",
      "- `scratch` *(function)* — `test/scratch.ts:1` (from `src/scratch.test.ts`)",
      "",
      "**1 syntax-only change**",
      "- `formatted` *(function)* — `src/formatted.test.ts:1`",
      "",
      "</details>",
      "",
    ])
  })

  const toggled = fixture("toggled")
  const pair = (name: string) =>
    [fixture(name), movedTo(fixture(name), `test/${name}.ts`, true)] as const
  it.each<[string, SymbolChange, string, string]>([
    [
      "an unknown entry",
      { status: "unknown", symbol: fixture("lost"), absentFrom: "head", reason: "over-size" },
      "**1 unknown**",
      "- `lost` *(function)* — `src/lost.test.ts:1` (skipped at head: over-size)",
    ],
    [
      "a dropped-toggled entry",
      {
        status: "dropped-toggled",
        before: toggled,
        after: { ...toggled, dropped: true, dropReason: "pure DTO" },
        direction: "to-dropped",
      },
      "**1 dropped change**",
      "- `toggled` *(function)* — `src/toggled.test.ts:1` (to-dropped)",
    ],
    [
      "a confidence-only change",
      changed(fixture("unsure"), { confidenceChanged: true }, { confidence: "low" }),
      "**1 confidence change**",
      "- `unsure` *(function)* ⚠ low — `src/unsure.test.ts:1` (`high` → `low`)",
    ],
    ...(["apiChanged", "confidenceChanged", "syntaxChanged"] as const).map(
      (flag): [string, SymbolChange, string, string] => [
        `a moved pair whose delta is ${flag} alone`,
        movedChanged(...pair(flag), { [flag]: true }),
        "**1 moved + changed**",
        `- \`${flag}\` *(function)* — \`test/${flag}.ts:1\` (from \`src/${flag}.test.ts\`)`,
      ],
    ),
  ])("are listed once, under their group: %s", (_, change, group, row) => {
    const fold = sectionOf(projectChanges([change]), HEADING)
    expect(fold.slice(fold.indexOf("<summary>1 symbol in a test file</summary>") + 1)).toEqual([
      "",
      group,
      row,
      "",
      "</details>",
      "",
    ])
  })

  it("are in no other section", () => {
    expect(sectionOf(md, "## ➕ Added").filter((line) => line.startsWith("###"))).toEqual([
      "### `order` *(function)*",
    ])
  })

  it("are counted on the Summary line, which counts every change", () => {
    expect(md).toContain(
      "**Summary**: +0 added · -0 removed · ~0 changed · 0 moved · 0 moved+changed · 8 in test files",
    )
    expect(projectChanges([{ status: "added", symbol: namedSymbol("order") }])).toContain(
      "**Summary**: +0 added · -0 removed · ~0 changed · 0 moved · 0 moved+changed\n",
    )
  })

  it("count one in the singular", () => {
    const one = projectChanges([{ status: "added", symbol: fixture("mock") }])
    expect(sectionOf(one, HEADING)).toContain("<summary>1 symbol in a test file</summary>")
    expect(one).toContain("· 1 in test files")
  })

  it.each([
    ["out of a test file is reviewed", false, "## 🔀 Moved"],
    ["into a test file is test code", true, HEADING],
  ])("are judged by the head, so a move %s", (_, intoTest, section) => {
    const before = intoTest ? namedSymbol("parse") : fixture("parse")
    const report = projectChanges([moved(before, movedTo(before, "src/parse/index.ts", intoTest))])
    expect(headings(report)).toEqual([section])
  })

  it("go first when the size cap omits a section", () => {
    const order: SymbolChange = { status: "added", symbol: namedSymbol("order") }
    const fixtures = Array.from(
      { length: 10 },
      (_, i): SymbolChange => ({ status: "added", symbol: fixture(`mock${i}`) }),
    )
    const capped = projectChanges([order, ...fixtures], {
      maxBytes: bytes(projectChanges([order])) + 400,
    })
    expect(headings(capped)).toEqual(["## ➕ Added"])
    expect(sectionOf(capped, "## ➕ Added")).toContain("### `order` *(function)*")
    expect(noteOf(capped)).toContain("**1 section was omitted**")
    expect(noteOf(capped)).toContain(": 🧪 Test files.")
  })
})

describe("projectDiff — the Dependency edges of test code", () => {
  const scratch = fixture("scratch")
  const renamed = {
    ...movedTo(scratch, "test/scratch.ts", true),
    id: symbolId("ts:test/scratch.ts#scratch"),
  }
  const total = "ts:src/order.ts#total"
  const testEdges = {
    added: [
      dependency({ from: fixture("makeOrder").id, to: total, via: "call" }),
      dependency({ from: renamed.id, to: total, via: "call" }),
    ],
    removed: [dependency({ from: scratch.id, to: total, via: "call" })],
  }
  const testChanges: SymbolChange[] = [
    { status: "added", symbol: fixture("makeOrder") },
    moved(scratch, renamed),
  ]

  it("go to the fold with the test changes that call through them, from either id of a pair", () => {
    const report = projectDiff(makeDiff({ symbols: testChanges, dependencies: testEdges }))
    expect(headings(report)).toEqual([HEADING])
    expect(sectionOf(report, HEADING)).toEqual([
      HEADING,
      "",
      "<details>",
      "<summary>2 symbols in test files</summary>",
      "",
      "**1 added**",
      "- `makeOrder` *(function)* — `src/makeOrder.test.ts:1`",
      "",
      "**1 moved**",
      "- `scratch` *(function)* — `test/scratch.ts:1` (from `src/scratch.test.ts`)",
      "",
      "**2 dependencies added**",
      "- `makeOrder` in `src/makeOrder.test.ts` → `total` in `src/order.ts` (via `call`)",
      "- `scratch` in `test/scratch.ts` → `total` in `src/order.ts` (via `call`)",
      "",
      "**1 dependency removed**",
      "- `scratch` in `src/scratch.test.ts` → `total` in `src/order.ts` (via `call`)",
      "",
      "</details>",
      "",
    ])
  })

  it("stay in the Dependency section when the caller is production code", () => {
    const checkout = namedSymbol("checkout")
    const report = projectDiff(
      makeDiff({
        symbols: [...testChanges, changed(checkout, { logicChanged: true })],
        dependencies: {
          added: [...testEdges.added, dependency({ from: checkout.id, to: total, via: "call" })],
          removed: testEdges.removed,
        },
      }),
    )
    expect(sectionOf(report, "## 🔗 Dependency changes")).toEqual([
      "## 🔗 Dependency changes",
      "",
      "### Symbol-level added",
      "- `checkout` in `src/checkout.ts` → `total` in `src/order.ts` (via `call`)",
      "",
    ])
  })
})

describe("projectDiff — the Slice View, beside test files", () => {
  const route = symbolAt("src/route.ts", "route", 3)
  const stub = symbolAt("src/route.test.ts", "stubRepo", 5, { inTestFile: true })
  const mock = symbolAt("src/route.test.ts", "mockClock", 9, { inTestFile: true })
  const added = (symbol: IRSymbol): SymbolChange => ({ status: "added", symbol })

  it("leaves out a Slice of test code alone, and a Symbol of test code alone", () => {
    const report = projectDiff(
      makeDiff({
        symbols: [added(withCallsTo(stub, [mock, 6])), added(mock), added(fixture("scratch"))],
        slices: [sliceOf(stub, mock), sliceOf(fixture("scratch"))],
      }),
    )
    expect(headings(report)).toEqual([HEADING])
  })

  it("keeps the test code of a Slice that reaches beyond it", () => {
    const report = projectDiff(
      makeDiff({
        symbols: [added(withCallsTo(stub, [route, 6])), added(route)],
        slices: [sliceOf(route, stub)],
      }),
    )
    expect(sectionOf(report, "## 🧵 Slice View").join("\n")).toContain("`stubRepo`")
  })
})
