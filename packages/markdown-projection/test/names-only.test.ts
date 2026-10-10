import {
  call,
  changed,
  emptySummary,
  fp,
  makeDiff,
  makeSymbol,
  moved,
  movedChanged,
  rule,
  symbolId,
} from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { namedSymbol, projectChanges, relocated, symbolWithBody } from "./fixtures"
import { bytes, headings, noteOf, sectionOf } from "./markdown"

const pad = (i: number, width = 4) => String(i).padStart(width, "0")

/** One byte short of the whole document: the smallest cut the size cap can be asked for. */
function justOver(changes: readonly SymbolChange[]): string {
  return projectChanges(changes, { maxBytes: bytes(projectChanges(changes)) - 1 })
}

describe("projectDiff — maxBytes writes a names-only row per entry", () => {
  const inFile = (i: number) => {
    const before = namedSymbol(`inFile${pad(i)}`)
    return movedChanged(
      before,
      {
        ...before,
        id: symbolId(`${before.id}Renamed`),
        name: `${before.name}Renamed`,
        source: { ...before.source, startLine: 40 },
      },
      { logicChanged: true },
      "name-signature",
    )
  }
  const across = (i: number) => {
    const before = namedSymbol(`across${pad(i)}`)
    return movedChanged(before, relocated(before, `src/moved/across${pad(i)}.ts`), {
      logicChanged: true,
    })
  }

  it.each<[string, string, SymbolChange[], string]>([
    [
      "an added Symbol",
      "## ➕ Added",
      Array.from({ length: 40 }, (_, i) => ({
        status: "added",
        symbol: symbolWithBody(`Added${pad(i)}`),
      })),
      "- `Added0000` *(function)* — `src/Added0000.ts:1`",
    ],
    [
      "a confidence change, with the badge and both values",
      "## 🎚 Confidence changes",
      Array.from({ length: 60 }, (_, i) =>
        changed(
          symbolWithBody(`Unsure${pad(i)}`),
          { confidenceChanged: true },
          {
            confidence: "medium",
          },
        ),
      ),
      "- `Unsure0000` *(function)* ⚠ medium — `src/Unsure0000.ts:1` (`high` → `medium`)",
    ],
    [
      "an unknown Symbol, with why it is listed",
      "## ❔ Unknown",
      Array.from({ length: 40 }, (_, i) => ({
        status: "unknown",
        symbol: namedSymbol(`gone${pad(i, 2)}`),
        absentFrom: "head",
        reason: "parse-timeout",
      })),
      "- `gone00` *(function)* — `src/gone00.ts:1` (skipped at head: parse-timeout)",
    ],
    [
      "a Symbol moved between files, with the path it came from",
      "## 🔀 Moved + Changed",
      Array.from({ length: 40 }, (_, i) => across(i)),
      "- `across0000` *(function)* — `src/moved/across0000.ts:1` (from `src/across0000.ts`)",
    ],
    [
      "a Symbol moved within its file, with the name and line it had",
      "## 🔀 Moved + Changed",
      Array.from({ length: 40 }, (_, i) => inFile(i)),
      "- `inFile0000Renamed` *(function)* — `src/inFile0000.ts:40` (from `inFile0000` at L1)",
    ],
  ])("for %s", (_, heading, changes, row) => {
    const md = justOver(changes)
    expect(noteOf(md)).toContain("names only")
    const section = sectionOf(md, heading)
    expect(section[2]).toBe(
      "_Names and locations only: the full entries did not fit within the size cap._",
    )
    expect(section).toContain(row)
  })

  it("says only that it listed names, when that was all it did", () => {
    const added = Array.from({ length: 40 }, (_, i) => ({
      status: "added" as const,
      symbol: symbolWithBody(`Added${pad(i)}`),
    }))
    const budget = bytes(projectChanges(added)) - 1
    expect(noteOf(projectChanges(added, { maxBytes: budget }))).toBe(
      `> ⚠ **1 section lists names only** to keep this report within ${budget} bytes: ➕ Added. The full report is the same diff rendered without a size cap.`,
    )
  })

  it("keeps a section with no names-only form rather than make room for names below it", () => {
    const notCompared = Array.from({ length: 30 }, (_, i) => ({
      path: `vendor/file${pad(i, 2)}.ts`,
      baseReason: "over-size" as const,
      headReason: "over-size" as const,
    }))
    const diff = makeDiff({
      summary: { ...emptySummary(), movedChanged: 3 },
      symbols: ["a", "b", "c"].map((name) => {
        const before = namedSymbol(name)
        return movedChanged(before, relocated(before, `src/moved/${name}.ts`))
      }),
      notCompared,
    })
    const md = projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 })
    expect(headings(md)).toEqual(["## 🚫 Not compared"])
    for (const file of notCompared) expect(md).toContain(`\`${file.path}\``)
  })

  it("never offers a names-only list longer than the section it stands for", () => {
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 21 },
      symbols: [
        changed(symbolWithBody("LogicOne"), { logicChanged: true }),
        ...Array.from({ length: 20 }, (_, i) =>
          changed(symbolWithBody(`Syntax${pad(i, 2)}`), { syntaxChanged: true }),
        ),
      ],
      notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" }],
    })
    const tight = bytes(projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 }))
    const md = projectDiff(diff, { maxBytes: tight })
    expect(headings(md)).toEqual(["## 🔧 Logic changes", "## 🚫 Not compared"])
    expect(md).not.toContain("_Names and locations only")
  })
})

describe("projectDiff — maxBytes over a 302-removal diff", () => {
  const COMMENT_BUDGET = 65507

  function heavySymbol(name: string): IRSymbol {
    return makeSymbol({
      id: `ts:packages/cli/src/commands/${name}.ts#${name}`,
      name,
      fingerprint: fp(name),
      rules: Array.from({ length: 4 }, (_, i) =>
        rule({ type: "guard", condition: `options.${name}Flag${i} !== undefined`, line: 10 + i }),
      ),
      calls: Array.from({ length: 6 }, (_, i) => call({ target: `helper${i}.run`, line: 20 + i })),
    })
  }

  const removed = Array.from({ length: 302 }, (_, i) => heavySymbol(`removed${pad(i)}`))
  const diff = makeDiff({
    summary: {
      ...emptySummary(),
      added: 142,
      removed: 302,
      changed: 326,
      moved: 25,
      movedChanged: 44,
    },
    symbols: [
      ...Array.from({ length: 142 }, (_, i) => ({
        status: "added" as const,
        symbol: heavySymbol(`added${pad(i)}`),
      })),
      ...removed.map((symbol) => ({ status: "removed" as const, symbol })),
      ...Array.from({ length: 60 }, (_, i) =>
        changed(heavySymbol(`api${pad(i)}`), { apiChanged: true }),
      ),
      ...Array.from({ length: 180 }, (_, i) =>
        changed(heavySymbol(`logic${pad(i)}`), { logicChanged: true }),
      ),
      ...Array.from({ length: 86 }, (_, i) =>
        changed(heavySymbol(`syntax${pad(i)}`), { syntaxChanged: true }),
      ),
      ...Array.from({ length: 25 }, (_, i) => {
        const before = symbolWithBody(`moved${pad(i)}`)
        return moved(before, relocated(before, `src/moved/moved${pad(i)}.ts`), "id-match")
      }),
      ...Array.from({ length: 44 }, (_, i) => {
        const before = heavySymbol(`movedChanged${pad(i)}`)
        return movedChanged(before, relocated(before, `src/moved/movedChanged${pad(i)}.ts`), {
          logicChanged: true,
        })
      }),
    ],
  })

  it("names every removed symbol within the comment budget", () => {
    expect(bytes(projectDiff(diff))).toBeGreaterThan(COMMENT_BUDGET)
    const md = projectDiff(diff, { maxBytes: COMMENT_BUDGET })
    expect(bytes(md)).toBeLessThanOrEqual(COMMENT_BUDGET)
    for (const symbol of removed) {
      expect(md).toContain(
        `- \`${symbol.name}\` *(${symbol.kind})* — \`${symbol.source.file}:${symbol.source.startLine}\``,
      )
    }
  })

  it("says which sections are short and which are gone, apart", () => {
    expect(noteOf(projectDiff(diff, { maxBytes: COMMENT_BUDGET }))).toBe(
      "> ⚠ **5 sections list names only** and **1 section was omitted** to keep this report within 65507 bytes. " +
        "Names only: ⚠ API changes, 🔧 Logic changes, ➕ Added, ➖ Removed, 🔀 Moved + Changed. " +
        "Omitted: 🎨 Syntax-only changes. The full report is the same diff rendered without a size cap.",
    )
  })

  it("keeps each list whose names still fit beside the more important ones", () => {
    const md = projectDiff(diff, { maxBytes: 12000 })
    expect(bytes(md)).toBeLessThanOrEqual(12000)
    expect(headings(md)).toEqual(["## ⚠ API changes", "## 🔀 Moved + Changed"])
    expect(noteOf(md)).toBe(
      "> ⚠ **2 sections list names only** and **5 sections were omitted** to keep this report within 12000 bytes. " +
        "Names only: ⚠ API changes, 🔀 Moved + Changed. " +
        "Omitted: 🔧 Logic changes, ➕ Added, ➖ Removed, 🔀 Moved, 🎨 Syntax-only changes. " +
        "The full report is the same diff rendered without a size cap.",
    )
  })

  it("shows whole only a top run of the lists it names, at every budget", () => {
    const shortenable = [
      "⚠ API changes",
      "🔧 Logic changes",
      "➕ Added",
      "➖ Removed",
      "🔀 Moved + Changed",
    ]
    let sawShort = false
    for (let budget = bytes(projectDiff(diff)); budget > 2000; budget = Math.floor(budget * 0.8)) {
      const md = projectDiff(diff, { maxBytes: budget })
      expect(bytes(md)).toBeLessThanOrEqual(budget)
      const lists = md
        .split("\n## ")
        .slice(1)
        .filter((section) => shortenable.some((title) => section.startsWith(`${title}\n`)))
      const isShort = (section: string) => section.includes("_Names and locations only")
      const firstShort = lists.findIndex(isShort)
      if (firstShort >= 0) {
        sawShort = true
        expect(lists.slice(firstShort).every(isShort)).toBe(true)
      }
    }
    expect(sawShort).toBe(true)
  })
})
