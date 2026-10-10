import { component, dependency, makeSymbol, sliceId, symbolId } from "@aburi/test-support"
import type { SymbolChange, SymbolDelta, SymbolDroppedToggled } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff, projectDiffSummaryLine } from "../src"
import {
  changed,
  emptySummary,
  makeDiff,
  moved,
  movedChanged,
  namedSymbol,
  projectChanges,
  relocated,
} from "./fixtures"
import { headings, sectionOf } from "./markdown"

describe("projectDiff — section order", () => {
  it("writes every section in importance order", () => {
    const movedOne = namedSymbol("movedOne")
    const movedTwo = namedSymbol("movedTwo")
    const toggled = namedSymbol("toggled")
    const md = projectDiff(
      makeDiff({
        symbols: [
          changed(namedSymbol("syntax"), { syntaxChanged: true }),
          changed(namedSymbol("unsure"), { confidenceChanged: true }, { confidence: "low" }),
          {
            status: "dropped-toggled",
            before: toggled,
            after: { ...toggled, dropped: true, dropReason: "pure DTO" },
            direction: "to-dropped",
          },
          moved(movedOne, relocated(movedOne, "src/elsewhere/movedOne.ts")),
          movedChanged(movedTwo, relocated(movedTwo, "src/elsewhere/movedTwo.ts")),
          {
            status: "unknown",
            symbol: namedSymbol("lost"),
            absentFrom: "head",
            reason: "over-size",
          },
          { status: "removed", symbol: namedSymbol("removed") },
          { status: "added", symbol: namedSymbol("added") },
          changed(namedSymbol("logic"), { logicChanged: true }),
          changed(namedSymbol("api"), { apiChanged: true }),
        ],
        slices: [
          { id: sliceId("slice:ts:src/api.ts#api"), members: [symbolId("ts:src/api.ts#api")] },
        ],
        notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" }],
        components: {
          added: [component({ id: "billing", name: "Billing" })],
          removed: [],
          changed: [],
        },
        dependencies: { added: [dependency({ from: "billing", to: "payments" })], removed: [] },
      }),
    )
    expect(headings(md)).toEqual([
      "## ⚠ API changes",
      "## 🔧 Logic changes",
      "## 🧵 Slice View",
      "## ➕ Added",
      "## ➖ Removed",
      "## ❔ Unknown",
      "## 🚫 Not compared",
      "## 🔀 Moved + Changed",
      "## 🔀 Moved",
      "## 🧱 Component changes",
      "## 🔗 Dependency changes",
      "## 💧 Dropped changes",
      "## 🎚 Confidence changes",
      "## 🎨 Syntax-only changes",
    ])
  })

  it("writes no section for a diff with nothing in it", () => {
    expect(headings(projectDiff(makeDiff()))).toEqual([])
  })
})

describe("projectDiff — which section a changed Symbol lands in", () => {
  const SECTIONS = {
    api: "## ⚠ API changes",
    logic: "## 🔧 Logic changes",
    confidence: "## 🎚 Confidence changes",
    syntax: "## 🎨 Syntax-only changes",
  } as const

  it.each<[string, Partial<SymbolDelta>, keyof typeof SECTIONS | null]>([
    ["api+logic", { apiChanged: true, logicChanged: true }, "api"],
    ["api+syntax", { apiChanged: true, syntaxChanged: true }, "api"],
    ["logic+syntax", { logicChanged: true, syntaxChanged: true }, "logic"],
    ["api+logic+syntax", { apiChanged: true, logicChanged: true, syntaxChanged: true }, "api"],
    ["api+confidence", { apiChanged: true, confidenceChanged: true }, "api"],
    ["logic+confidence", { logicChanged: true, confidenceChanged: true }, "logic"],
    ["confidence+syntax", { confidenceChanged: true, syntaxChanged: true }, "confidence"],
    ["confidence alone", { confidenceChanged: true }, "confidence"],
    [
      "syntax, confidence written false",
      { syntaxChanged: true, confidenceChanged: false },
      "syntax",
    ],
    // An older document has no key at all; only an explicit `true` may route on it.
    ["syntax, confidence key absent", { syntaxChanged: true }, "syntax"],
    // Every axis false should be `unchanged` upstream; if it slips through, no section may fire.
    ["no axis", {}, null],
  ])("routes %s to exactly one section", (_, flags, expected) => {
    const md = projectChanges([changed(namedSymbol("Foo"), flags)])
    expect(headings(md)).toEqual(expected === null ? [] : [SECTIONS[expected]])
  })
})

describe("projectDiff — folded sections", () => {
  const toggle = (name: string, direction: SymbolDroppedToggled["direction"]) => {
    const kept = makeSymbol({ id: `ts:src/a.ts#${name}`, name })
    const dropped = { ...kept, dropped: true, dropReason: "pure DTO" }
    return {
      status: "dropped-toggled" as const,
      before: direction === "to-dropped" ? kept : dropped,
      after: direction === "to-dropped" ? dropped : kept,
      direction,
    }
  }
  const movedFromOld = (name: string) =>
    moved(
      makeSymbol({ id: `ts:src/old.ts#${name}`, name }),
      makeSymbol({ id: `ts:src/new.ts#${name}`, name }),
    )
  const changes: SymbolChange[] = [
    movedFromOld("MovedB"),
    movedFromOld("MovedA"),
    toggle("C", "to-kept"),
    toggle("B", "to-dropped"),
    toggle("A", "to-dropped"),
    changed(makeSymbol({ id: "ts:src/a.ts#SyntaxB", name: "SyntaxB" }), { syntaxChanged: true }),
    changed(makeSymbol({ id: "ts:src/a.ts#SyntaxA", name: "SyntaxA" }), { syntaxChanged: true }),
  ]
  const md = projectChanges(changes)

  it("folds the moves, one line each, under a count of entries", () => {
    expect(sectionOf(md, "## 🔀 Moved")).toEqual([
      "## 🔀 Moved",
      "",
      "<details>",
      "<summary>2 entries</summary>",
      "",
      "- `MovedA`: `src/old.ts` → `src/new.ts` (`git-rename`)",
      "- `MovedB`: `src/old.ts` → `src/new.ts` (`git-rename`)",
      "",
      "</details>",
      "",
    ])
  })

  it("folds the dropped toggles by direction, counting entries rather than rows", () => {
    expect(sectionOf(md, "## 💧 Dropped changes")).toEqual([
      "## 💧 Dropped changes",
      "",
      "<details>",
      "<summary>3 entries</summary>",
      "",
      "**2 to-dropped**",
      "- `ts:src/a.ts#A` — pure DTO",
      "- `ts:src/a.ts#B` — pure DTO",
      "",
      "**1 to-kept**",
      "- `ts:src/a.ts#C`",
      "",
      "</details>",
      "",
    ])
  })

  it("folds the syntax-only changes, one location each", () => {
    expect(sectionOf(md, "## 🎨 Syntax-only changes").slice(0, 7)).toEqual([
      "## 🎨 Syntax-only changes",
      "",
      "<details>",
      "<summary>2 entries</summary>",
      "",
      "- `SyntaxA` (`src/a.ts:1`)",
      "- `SyntaxB` (`src/a.ts:1`)",
    ])
  })

  it("writes a moved and changed Symbol as a full entry outside any fold", () => {
    const before = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" })
    const after = makeSymbol({ id: "ts:src/new.ts#Foo", name: "Foo" })
    const section = sectionOf(
      projectChanges([movedChanged(before, after, { logicChanged: true })]),
      "## 🔀 Moved + Changed",
    )
    expect(section).toContain("**Delta**:")
    expect(section).not.toContain("<details>")
  })
})

describe("projectDiff — Summary lines", () => {
  const summary = {
    ...emptySummary(),
    added: 5,
    removed: 3,
    changed: 12,
    moved: 2,
    movedChanged: 1,
  }

  it("writes the CLI's one-line summary as `+A -R ~C ↔M ⤴MC`", () => {
    expect(projectDiffSummaryLine(makeDiff({ summary }))).toBe("+5 -3 ~12 ↔2 ⤴1")
  })

  it("writes the document's Summary line with every count named", () => {
    expect(projectDiff(makeDiff({ summary }))).toContain(
      "**Summary**: +5 added · -3 removed · ~12 changed · 2 moved · 1 moved+changed\n",
    )
  })

  it("qualifies both with the unknown count, so the counts beside it are not read as complete", () => {
    const diff = makeDiff({ summary: { ...summary, unknown: 4 } })
    expect(projectDiffSummaryLine(diff)).toBe("+5 -3 ~12 ↔2 ⤴1 · ?4 unknown")
    expect(projectDiff(diff)).toContain("1 moved+changed · ?4 unknown\n")
  })

  it("leaves both alone when nothing is unknown, or the diff predates the counter", () => {
    for (const diff of [makeDiff({ summary: { ...summary, unknown: 0 } }), makeDiff({ summary })]) {
      expect(projectDiffSummaryLine(diff)).not.toContain("unknown")
      expect(projectDiff(diff)).not.toContain("unknown")
    }
  })
})
