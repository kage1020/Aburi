import {
  call,
  changed,
  component,
  emptySummary,
  fp,
  makeDiff,
  makeSymbol,
  moved,
  movedChanged,
  rule,
  symbolId,
} from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { namedSymbol, projectChanges, relocated, symbolWithBody } from "./fixtures"
import { bytes, headings, noteOf, sectionOf } from "./markdown"

const pad = (i: number, width = 4) => String(i).padStart(width, "0")

const NAMES_ONLY_LINE =
  "_Names and locations only: the full entries did not fit within the size cap._"

/**
 * Each cut is one byte short of the last document, the smallest the size cap can be asked for. A
 * section above Moved + Changed that shares its pairs takes two: the first shortens Moved + Changed,
 * whose entries for the same pairs are longer.
 */
function firstNamesOnly(changes: readonly SymbolChange[], heading: string): string {
  let md = projectChanges(changes)
  do md = projectChanges(changes, { maxBytes: bytes(md) - 1 })
  while (sectionOf(md, heading)[2] !== NAMES_ONLY_LINE)
  return md
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
  const acrossRenamed = (i: number, flags: Partial<SymbolDelta> = { apiChanged: true }) => {
    const before = namedSymbol(`parse${pad(i)}`)
    const file = `src/amount/read${pad(i)}.ts`
    const after = { ...relocated(before, file), id: symbolId(`ts:${file}#read${pad(i)}`) }
    return movedChanged(before, { ...after, name: `read${pad(i)}` }, flags)
  }
  const reowned = (i: number, flags: Partial<SymbolDelta>, after: Partial<IRSymbol> = {}) => {
    const file = `src/repo${pad(i)}.ts`
    const before = makeSymbol({ id: `ts:${file}#Repo${pad(i)}.save`, name: `Repo${pad(i)}.save` })
    const name = `UserRepo${pad(i)}.save`
    const source = { ...before.source, startLine: 30 }
    const head = { ...before, id: symbolId(`ts:${file}#${name}`), name, source, ...after }
    return movedChanged(before, head, flags, "name-signature")
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
      "a Symbol moved between files and renamed, with the name and path it had",
      "## 🔀 Moved + Changed",
      Array.from({ length: 40 }, (_, i) => acrossRenamed(i)),
      "- `read0000` *(function)* — `src/amount/read0000.ts:1` (from `parse0000` in `src/parse0000.ts`)",
    ],
    [
      "a Symbol moved within its file, with the name and line it had",
      "## 🔀 Moved + Changed",
      Array.from({ length: 40 }, (_, i) => inFile(i)),
      "- `inFile0000Renamed` *(function)* — `src/inFile0000.ts:40` (from `inFile0000` at L1)",
    ],
    [
      "an API change whose name changed, with the name and path it had",
      "## ⚠ API changes",
      Array.from({ length: 40 }, (_, i) => acrossRenamed(i)),
      "- `read0000` *(function)* — `src/amount/read0000.ts:1` (from `parse0000` in `src/parse0000.ts`)",
    ],
    [
      "a logic change whose name changed, with the name and line it had",
      "## 🔧 Logic changes",
      Array.from({ length: 40 }, (_, i) => reowned(i, { logicChanged: true })),
      "- `UserRepo0000.save` *(function)* — `src/repo0000.ts:30` (from `Repo0000.save` at L1)",
    ],
    [
      "a confidence change whose name changed, with the name it had before both values",
      "## 🎚 Confidence changes",
      Array.from({ length: 40 }, (_, i) =>
        reowned(i, { confidenceChanged: true }, { confidence: "medium" }),
      ),
      "- `UserRepo0000.save` *(function)* ⚠ medium — `src/repo0000.ts:30` (from `Repo0000.save` at L1) (`high` → `medium`)",
    ],
  ])("for %s", (_, heading, changes, row) => {
    expect(sectionOf(firstNamesOnly(changes, heading), heading)).toContain(row)
  })

  it("keeps a pair's old name where API changes lists names only and Moved + Changed is omitted", () => {
    const guards = Array.from({ length: 4 }, (_, i) =>
      rule({ type: "guard", condition: `amount${i} !== null`, line: 3 + i }),
    )
    const changes = Array.from({ length: 40 }, (_, i) =>
      acrossRenamed(i, {
        apiChanged: true,
        logicChanged: true,
        rules: { added: guards, removed: [], modified: [] },
      }),
    )
    let md = projectChanges(changes)
    while (headings(md).includes("## 🔀 Moved + Changed")) {
      md = projectChanges(changes, { maxBytes: bytes(md) - 1 })
    }
    expect(noteOf(md)).toContain("Names only: ⚠ API changes. Omitted: 🔀 Moved + Changed.")
    for (let i = 0; i < 40; i++) {
      expect(md).toContain(`(from \`parse${pad(i)}\` in \`src/parse${pad(i)}.ts\`)`)
    }
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

describe("projectDiff — maxBytes weighs a names-only form with its name in the note", () => {
  // One thin Symbol saves a couple of bytes as a names-only row and spends more on the note.
  const thinRemoval: SymbolChange = {
    status: "removed",
    symbol: makeSymbol({ id: "ts:src/billing/invoice.ts#voidInvoice", name: "voidInvoice" }),
  }

  it("keeps a section whole when that is smaller than naming it in the note", () => {
    const diff = makeDiff({
      symbols: [
        thinRemoval,
        ...Array.from({ length: 8 }, (_, i) =>
          changed(makeSymbol({ id: `ts:src/s.ts#helper${i}`, name: `helper${i}` }), {
            syntaxChanged: true,
          }),
        ),
      ],
      summary: { ...emptySummary(), removed: 1, changed: 8, componentsAdded: 1 },
      components: {
        added: [component({ id: "payments", name: "Payments", roots: ["apps/payments"] })],
        removed: [],
        changed: [],
      },
    })
    const whole = bytes(projectDiff(diff))
    const both = bytes(projectDiff(diff, { maxBytes: whole - 1 }))
    for (let budget = both; budget < whole; budget++) {
      const md = projectDiff(diff, { maxBytes: budget })
      expect(headings(md), `at ${budget}`).toEqual(["## ➖ Removed", "## 🧱 Component changes"])
      expect(bytes(md)).toBeLessThanOrEqual(budget)
    }
    const removedOnly = projectDiff(diff, { maxBytes: both - 1 })
    expect(headings(removedOnly)).toEqual(["## ➖ Removed"])
    expect(removedOnly).not.toContain("_Names and locations only")
  })

  it("keeps a thin section whole below a names-only one", () => {
    const diff = makeDiff({
      symbols: [
        ...Array.from({ length: 12 }, (_, i) =>
          changed(makeSymbol({ id: `ts:src/api.ts#api${i}`, name: `api${i}` }), {
            apiChanged: true,
          }),
        ),
        thinRemoval,
      ],
      summary: { ...emptySummary(), removed: 1, changed: 12 },
    })
    const tight = projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 })
    expect(headings(tight)).toEqual(["## ⚠ API changes", "## ➖ Removed"])
    expect(noteOf(tight)).toContain("**1 section lists names only**")
    expect(sectionOf(tight, "## ➖ Removed")).toContain("### `voidInvoice` *(function)*")
    // At exactly its own size the same document comes back: only the budget in the note differs.
    const md = projectDiff(diff, { maxBytes: bytes(tight) })
    expect(md.replace(/within \d+ bytes/, "")).toBe(tight.replace(/within \d+ bytes/, ""))
    expect(headings(projectDiff(diff, { maxBytes: bytes(tight) - 1 }))).toEqual([
      "## ⚠ API changes",
    ])
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

  it("shows a list whole below a names-only one only where names-only is no smaller", () => {
    const shortenable = [
      "⚠ API changes",
      "🔧 Logic changes",
      "➕ Added",
      "➖ Removed",
      "🔀 Moved + Changed",
    ]
    const listsIn = (md: string) =>
      md
        .split("\n## ")
        .slice(1)
        .flatMap((text) => {
          const title = shortenable.find((candidate) => text.startsWith(`${candidate}\n`))
          const short = text.includes("_Names and locations only")
          return title === undefined ? [] : [{ title, size: bytes(text), short }]
        })
    const atCommentBudget = listsIn(projectDiff(diff, { maxBytes: COMMENT_BUDGET }))
    expect(atCommentBudget.filter(({ short }) => short).map(({ title }) => title)).toEqual(
      shortenable,
    )
    const namesOnly = new Map(atCommentBudget.map(({ title, size }) => [title, size]))

    let sawShort = false
    for (let budget = bytes(projectDiff(diff)); budget > 2000; budget = Math.floor(budget * 0.8)) {
      const md = projectDiff(diff, { maxBytes: budget })
      expect(bytes(md)).toBeLessThanOrEqual(budget)
      const lists = listsIn(md)
      const firstShort = lists.findIndex(({ short }) => short)
      if (firstShort < 0) continue
      sawShort = true
      for (const { title, size, short } of lists.slice(firstShort)) {
        if (short) continue
        // Naming one more section in the note costs its title and a separator.
        const asNamesOnly = (namesOnly.get(title) ?? 0) + bytes(`, ${title}`)
        expect(asNamesOnly, `${title} at ${budget}`).toBeGreaterThanOrEqual(size)
      }
    }
    expect(sawShort).toBe(true)
  })
})
