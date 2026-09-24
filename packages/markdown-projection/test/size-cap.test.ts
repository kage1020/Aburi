import { call, fp, makeSymbol, rule } from "@aburi/test-support"
import type {
  Symbol as IRSymbol,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolUnknown,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { type Arrangement, arrangeWithin, type Section } from "../src/diff"
import { emptySummary, makeDiff } from "./fixtures"

/**
 * `maxBytes` (markdown-projection.md). The document GitHub takes as a PR comment body has a
 * 65536-byte ceiling, and `projectDiff` used to emit whatever the diff was worth: roughly
 * 210 bytes per added symbol, so a pull request adding ~310 symbols produced a body the API
 * rejected with a 422 and nothing was posted at all.
 */

const GITHUB_LIMIT = 65536

function bytes(markdown: string): number {
  return Buffer.byteLength(markdown, "utf8")
}

function noteOf(markdown: string): string {
  return markdown.split("\n").find((line) => line.startsWith("> ⚠")) ?? ""
}

function headings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("## "))
}

function addedSymbols(count: number, prefix = "Added"): SymbolChange[] {
  return Array.from({ length: count }, (_, i) => ({
    status: "added" as const,
    symbol: symbolOf(`${prefix}${String(i).padStart(4, "0")}`),
  }))
}

/** One rule and one call — the "minimal symbol" the issue measured at ~210 bytes rendered. */
function symbolOf(name: string): IRSymbol {
  return makeSymbol({
    id: `ts:src/${name}.ts#${name}`,
    name,
    fingerprint: fp(name),
    rules: [rule({ type: "guard", condition: "input !== null", line: 3 })],
    calls: [call({ target: "logger.info", line: 4 })],
  })
}

function delta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: overrides.apiChanged ?? false,
    logicChanged: overrides.logicChanged ?? false,
    syntaxChanged: overrides.syntaxChanged ?? false,
    componentChanged: false,
    visibilityChanged: false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
  }
}

function changed(name: string, flags: Partial<SymbolDelta>): SymbolChanged {
  const before = symbolOf(name)
  return {
    status: "changed",
    before,
    after: { ...before, fingerprint: fp(`${name}-v2`) },
    delta: delta(flags),
  }
}

function moved(name: string): SymbolMoved {
  const before = symbolOf(name)
  return {
    status: "moved",
    before,
    after: { ...before, source: { ...before.source, file: `src/moved/${name}.ts` } },
    rationale: "id-match",
  }
}

function droppedToggled(name: string): SymbolDroppedToggled {
  const before = symbolOf(name)
  return {
    status: "dropped-toggled",
    before,
    after: { ...before, dropped: true, dropReason: "pure DTO" },
    direction: "to-dropped",
  }
}

/** A diff that fills every section this test cares about, sized by the added count. */
function crowdedDiff(addedCount: number): ReturnType<typeof makeDiff> {
  const symbols: SymbolChange[] = [
    ...addedSymbols(addedCount),
    changed("ApiOne", { apiChanged: true }),
    changed("LogicOne", { logicChanged: true }),
    changed("SyntaxOne", { syntaxChanged: true }),
    moved("MovedOne"),
    droppedToggled("ToggledOne"),
  ]
  return makeDiff({
    summary: {
      ...emptySummary(),
      added: addedCount,
      changed: 3,
      moved: 1,
      droppedToggled: 1,
    },
    symbols,
  })
}

describe("projectDiff — maxBytes", () => {
  it("emits the whole document when no budget is given", () => {
    const md = projectDiff(crowdedDiff(400))
    expect(bytes(md)).toBeGreaterThan(GITHUB_LIMIT)
    expect(md).toContain("## 🎨 Syntax-only changes")
    expect(md).not.toContain("omitted")
  })

  it("keeps a diff that would 422 under GitHub's comment limit", () => {
    const md = projectDiff(crowdedDiff(400), { maxBytes: GITHUB_LIMIT })
    expect(bytes(md)).toBeLessThanOrEqual(GITHUB_LIMIT)
    expect(md).toContain("# Aburi diff: main..HEAD")
    expect(md).toContain("**Summary**: +400 added")
  })

  it("leaves a document that already fits byte-identical", () => {
    const small = crowdedDiff(2)
    const uncapped = projectDiff(small)
    expect(bytes(uncapped)).toBeLessThan(GITHUB_LIMIT)
    expect(projectDiff(small, { maxBytes: GITHUB_LIMIT })).toBe(uncapped)
  })

  it("keeps what it keeps in document order, within the budget, at every budget", () => {
    // The byte assertion rides along, because "in order" alone is satisfied by dropping
    // everything at every budget — and because an implementation that built the note once,
    // while it was still empty, and measured before appending it would pass the rest of this.
    const diff = crowdedDiff(40)
    const order = headings(projectDiff(diff))
    const full = bytes(projectDiff(diff))
    expect(order.length).toBeGreaterThan(1)
    for (let budget = full; budget > 0; budget -= 97) {
      const md = projectDiff(diff, { maxBytes: budget })
      const kept = headings(md)
      expect(kept).toEqual(order.filter((heading) => kept.includes(heading)))
      // Over budget is allowed only on the one path that cannot do better: nothing kept.
      if (kept.length > 0) expect(bytes(md)).toBeLessThanOrEqual(budget)
    }
    // The non-vacuous end: a budget the whole document already fits keeps every section.
    expect(headings(projectDiff(diff, { maxBytes: full }))).toEqual(order)
  })

  it("keeps what fits below a section too large to fit even as names", () => {
    // 400 added names cannot fit in 2000 bytes beside anything, and dropping the sections under
    // them would not make them fit: those stay.
    const md = projectDiff(crowdedDiff(400), { maxBytes: 2000 })
    expect(headings(md)).toEqual([
      "## ⚠ API changes",
      "## 🔧 Logic changes",
      "## 🔀 Moved",
      "## 💧 Dropped changes",
      "## 🎨 Syntax-only changes",
    ])
    expect(noteOf(md)).toBe(
      "> ⚠ **1 section was omitted** to keep this report within 2000 bytes: ➕ Added. The full report is the same diff rendered without a size cap.",
    )
  })

  it("drops only what the budget requires", () => {
    // Syntax-only carries 300 symbols and everything else is a handful: a budget with room for
    // the rest takes that one section and stops.
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 301, moved: 1 },
      symbols: [
        changed("ApiOne", { apiChanged: true }),
        moved("MovedOne"),
        ...Array.from({ length: 300 }, (_, i) =>
          changed(`Syntax${String(i).padStart(4, "0")}`, { syntaxChanged: true }),
        ),
      ],
    })
    const md = projectDiff(diff, { maxBytes: 4000 })
    expect(md).toContain("**1 section was omitted**")
    expect(md).toContain("## ⚠ API changes")
    expect(md).toContain("## 🔀 Moved")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })

  it("names what it dropped, in the order the document would have shown them", () => {
    const md = projectDiff(crowdedDiff(400), { maxBytes: 1 })
    expect(noteOf(md)).toContain(
      ": ⚠ API changes, 🔧 Logic changes, ➕ Added, 🔀 Moved, 💧 Dropped changes, 🎨 Syntax-only changes.",
    )
  })

  it("never cuts a `<details>` block in half", () => {
    // Every budget from "everything fits" down to "nothing does" leaves the folds balanced.
    // Counted against the folds the document actually has, so a run that dropped every folded
    // section does not pass this by having none.
    const diff = crowdedDiff(40)
    const full = bytes(projectDiff(diff))
    expect(projectDiff(diff).split("<details>").length - 1).toBeGreaterThan(0)
    for (let budget = full; budget > 0; budget -= 97) {
      const md = projectDiff(diff, { maxBytes: budget })
      expect(md.split("<details>").length).toBe(md.split("</details>").length)
    }
  })

  it("keeps the title and the Summary when every section is dropped", () => {
    const md = projectDiff(crowdedDiff(400), { maxBytes: 1 })
    expect(md).toContain("# Aburi diff: main..HEAD")
    expect(md).toContain("**Summary**: +400 added")
    expect(md).toContain("**6 sections were omitted**")
    expect(md).not.toContain("## ⚠ API changes")
  })

  it("says it could not fit, rather than claiming a budget it missed", () => {
    // The one document that comes back over budget is the one that cannot do better. A note
    // reading "to keep this report within 1 bytes" on a 300-byte document is the report
    // contradicting itself at the one moment a reader needs it to be exact.
    const md = projectDiff(crowdedDiff(400), { maxBytes: 1 })
    expect(bytes(md)).toBeGreaterThan(1)
    expect(md).toContain("could not be brought within 1 bytes")
    expect(md).not.toContain("to keep this report within 1 bytes")
  })

  it("keeps the ordinary wording when nothing is left but the document still fits", () => {
    // Every section dropped is not the same answer as "impossible": with room for the heading
    // and the note, the budget was met, and the note should say so.
    const diff = crowdedDiff(400)
    // The floor: what the document weighs once every section is gone. Budgeting exactly that
    // drops them all and still fits, because the note that says "could not" is the longer one.
    const floor = bytes(projectDiff(diff, { maxBytes: 1 }))
    const md = projectDiff(diff, { maxBytes: floor })
    expect(headings(md)).toEqual([])
    expect(bytes(md)).toBeLessThanOrEqual(floor)
    expect(md).toContain(`to keep this report within ${floor} bytes`)
    expect(md).not.toContain("could not be brought")
  })

  it("is deterministic under a budget (MP1)", () => {
    const diff = crowdedDiff(300)
    expect(projectDiff(diff, { maxBytes: GITHUB_LIMIT })).toBe(
      projectDiff(diff, { maxBytes: GITHUB_LIMIT }),
    )
  })

  it("rejects a budget that is not a positive integer", () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => projectDiff(crowdedDiff(1), { maxBytes })).toThrow(RangeError)
    }
  })
})

describe("projectDiff — maxBytes degrades a section before dropping it", () => {
  // A large refactor: `+142 added · -302 removed · ~326 changed · 25 moved · 44 moved+changed`.
  // Dropping whole sections left API changes standing alone, and the 302 deleted symbols — the
  // ones `--fail-on removed` gates on — were named nowhere.
  const COMMENT_BUDGET = 65507

  /** A symbol heavy enough that a few hundred of them cannot all be rendered in full. */
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

  function movedChanged(name: string): SymbolMovedChanged {
    const before = heavySymbol(name)
    return {
      status: "moved+changed",
      before,
      after: { ...before, source: { ...before.source, file: `src/moved/${name}.ts` } },
      rationale: "git-rename",
      delta: delta({ logicChanged: true }),
    }
  }

  function changedHeavy(name: string, flags: Partial<SymbolDelta>): SymbolChanged {
    const before = heavySymbol(name)
    return {
      status: "changed",
      before,
      after: { ...before, fingerprint: fp(`${name}-v2`) },
      delta: delta(flags),
    }
  }

  const pad = (i: number) => String(i).padStart(4, "0")
  const removed = Array.from({ length: 302 }, (_, i) => heavySymbol(`removed${pad(i)}`))
  const diffOf302Removed = makeDiff({
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
      ...Array.from({ length: 60 }, (_, i) => changedHeavy(`api${pad(i)}`, { apiChanged: true })),
      ...Array.from({ length: 180 }, (_, i) =>
        changedHeavy(`logic${pad(i)}`, { logicChanged: true }),
      ),
      ...Array.from({ length: 86 }, (_, i) =>
        changedHeavy(`syntax${pad(i)}`, { syntaxChanged: true }),
      ),
      ...Array.from({ length: 25 }, (_, i) => moved(`moved${pad(i)}`)),
      ...Array.from({ length: 44 }, (_, i) => movedChanged(`movedChanged${pad(i)}`)),
    ],
  })

  it("names every removed symbol of a 302-removal diff within the comment budget", () => {
    expect(bytes(projectDiff(diffOf302Removed))).toBeGreaterThan(COMMENT_BUDGET)
    const md = projectDiff(diffOf302Removed, { maxBytes: COMMENT_BUDGET })
    expect(bytes(md)).toBeLessThanOrEqual(COMMENT_BUDGET)
    for (const symbol of removed) {
      expect(md).toContain(
        `- \`${symbol.name}\` *(${symbol.kind})* — \`${symbol.source.file}:${symbol.source.startLine}\``,
      )
    }
  })

  it("says which sections are short and which are gone, apart", () => {
    const md = projectDiff(diffOf302Removed, { maxBytes: COMMENT_BUDGET })
    expect(noteOf(md)).toBe(
      "> ⚠ **5 sections list names only** and **1 section was omitted** to keep this report within 65507 bytes. " +
        "Names only: ⚠ API changes, 🔧 Logic changes, ➕ Added, ➖ Removed, 🔀 Moved + Changed. " +
        "Omitted: 🎨 Syntax-only changes. The full report is the same diff rendered without a size cap.",
    )
    // And in place, for a reader who opened the section rather than the note.
    const removedSection = md.slice(md.indexOf("## ➖ Removed"))
    expect(removedSection.split("\n")[2]).toMatch(/^_Names and locations only/)
    // A moved and changed Symbol's row says where it came from, which its location alone cannot.
    expect(md).toContain(
      "- `movedChanged0000` *(function)* — `src/moved/movedChanged0000.ts:1` (from `packages/cli/src/commands/movedChanged0000.ts`)",
    )
  })

  it("shows whole only a top run of the lists it names, at every budget", () => {
    // Once one list is names-only, every list below it is names-only or gone: a reader who
    // meets the first short section knows the rest of the document is short too.
    const full = bytes(projectDiff(diffOf302Removed))
    const shortenable = [
      "⚠ API changes",
      "🔧 Logic changes",
      "➕ Added",
      "➖ Removed",
      "🔀 Moved + Changed",
    ]
    let sawShort = false
    for (let budget = full; budget > 2000; budget = Math.floor(budget * 0.8)) {
      const md = projectDiff(diffOf302Removed, { maxBytes: budget })
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

  it("keeps each list whose names still fit beside the more important ones", () => {
    // 12000 bytes holds the 60 API names, not the 180 Logic ones beside them; the 44 moved and
    // changed names still fit below the lists that went, so they stay.
    const md = projectDiff(diffOf302Removed, { maxBytes: 12000 })
    expect(bytes(md)).toBeLessThanOrEqual(12000)
    expect(headings(md)).toEqual(["## ⚠ API changes", "## 🔀 Moved + Changed"])
    expect(noteOf(md)).toBe(
      "> ⚠ **2 sections list names only** and **5 sections were omitted** to keep this report within 12000 bytes. " +
        "Names only: ⚠ API changes, 🔀 Moved + Changed. " +
        "Omitted: 🔧 Logic changes, ➕ Added, ➖ Removed, 🔀 Moved, 🎨 Syntax-only changes. " +
        "The full report is the same diff rendered without a size cap.",
    )
  })

  it('says only "omitted" once every section is gone', () => {
    const md = projectDiff(crowdedDiff(0), { maxBytes: 1 })
    expect(md).toContain("**5 sections were omitted**")
    expect(md).not.toContain("names only")
  })
})

describe("projectDiff — maxBytes against the sections above", () => {
  it("keeps a section with no names-only form rather than make room for names below it", () => {
    // Thirty files not compared, then three moved and changed Symbols. One byte over, the only
    // way to name the three is to drop the thirty, which would trade the more important section
    // for the less.
    const blank: SymbolDelta = delta()
    const movedChangedThin = (name: string): SymbolMovedChanged => {
      const before = makeSymbol({ id: `ts:src/${name}.ts#${name}`, name, fingerprint: fp(name) })
      return {
        status: "moved+changed",
        before,
        after: { ...before, source: { ...before.source, file: `src/moved/${name}.ts` } },
        rationale: "git-rename",
        delta: blank,
      }
    }
    const notCompared = Array.from({ length: 30 }, (_, i) => ({
      path: `vendor/file${String(i).padStart(2, "0")}.ts`,
      baseReason: "over-size" as const,
      headReason: "over-size" as const,
    }))
    const diff = makeDiff({
      summary: { ...emptySummary(), movedChanged: 3 },
      symbols: ["a", "b", "c"].map(movedChangedThin),
      notCompared,
    })
    const md = projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 })
    expect(headings(md)).toEqual(["## 🚫 Not compared"])
    for (const file of notCompared) expect(md).toContain(`\`${file.path}\``)
  })

  it("never offers a names-only list longer than the section it stands for", () => {
    // One changed Symbol with nothing in its delta is shorter whole than as a list with the line
    // saying it is one. Offered anyway, it would be kept in that longer form while the cap
    // decides what else fits, and at a budget with no byte to spare the section below it would
    // go to pay for it.
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 21 },
      symbols: [
        changed("LogicOne", { logicChanged: true }),
        ...Array.from({ length: 20 }, (_, i) =>
          changed(`Syntax${String(i).padStart(2, "0")}`, { syntaxChanged: true }),
        ),
      ],
      notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" }],
    })
    const tight = bytes(projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 }))
    const md = projectDiff(diff, { maxBytes: tight })
    expect(headings(md)).toEqual(["## 🔧 Logic changes", "## 🚫 Not compared"])
    expect(md).not.toContain("_Names and locations only")
  })

  it("says only that it listed names, when that was all it did", () => {
    const diff = makeDiff({ summary: { ...emptySummary(), added: 40 }, symbols: addedSymbols(40) })
    const budget = bytes(projectDiff(diff)) - 1
    const md = projectDiff(diff, { maxBytes: budget })
    expect(noteOf(md)).toBe(
      `> ⚠ **1 section lists names only** to keep this report within ${budget} bytes: ➕ Added. The full report is the same diff rendered without a size cap.`,
    )
  })

  it("says why an unknown Symbol is listed, in its names-only row", () => {
    const unknown = (name: string): SymbolUnknown => ({
      status: "unknown",
      symbol: makeSymbol({ id: `ts:src/${name}.ts#${name}`, name, fingerprint: fp(name) }),
      absentFrom: "head",
      reason: "parse-timeout",
    })
    const diff = makeDiff({
      summary: { ...emptySummary(), unknown: 40 },
      symbols: Array.from({ length: 40 }, (_, i) => unknown(`gone${String(i).padStart(2, "0")}`)),
    })
    const md = projectDiff(diff, { maxBytes: bytes(projectDiff(diff)) - 1 })
    expect(md).toContain(
      "- `gone00` *(function)* — `src/gone00.ts:1` (skipped at head: parse-timeout)",
    )
  })

  it("says it is over budget even when there is no section to drop", () => {
    const md = projectDiff(makeDiff(), { maxBytes: 1 })
    expect(noteOf(md)).toBe("> ⚠ This report could not be brought within 1 bytes.")
  })

  it("names where the full report is, and refuses a location that would break the note", () => {
    const diff = crowdedDiff(400)
    const md = projectDiff(diff, {
      maxBytes: GITHUB_LIMIT,
      fullReportLocation: "`diff.full.md` beside `diff.md`",
    })
    expect(noteOf(md)).toMatch(
      /The full report, the same diff without a size cap, is `diff\.full\.md` beside `diff\.md`\.$/,
    )
    expect(() =>
      projectDiff(diff, { maxBytes: GITHUB_LIMIT, fullReportLocation: "one\ntwo" }),
    ).toThrow(RangeError)
  })
})

describe("arrangeWithin — checked against every arrangement of small inputs", () => {
  // Sizes are line counts and the budget a line count, so what fits is plain arithmetic and
  // every arrangement of five sections (at most 3^5) can be listed and ranked.
  function section(title: string, full: number, short: number | null): Section {
    const lines = (count: number) => Array.from({ length: count }, () => title)
    return { title, lines: lines(full), ...(short === null ? {} : { short: lines(short) }) }
  }

  function size(arrangement: Arrangement): number {
    let total = 0
    for (const { section, shown } of arrangement) {
      if (shown.kind === "full") total += section.lines.length
      if (shown.kind === "short") total += shown.lines.length
    }
    return total
  }

  function* every(sections: readonly Section[]): Generator<Arrangement> {
    const [first, ...rest] = sections
    if (first === undefined) {
      yield []
      return
    }
    const forms: Arrangement[number]["shown"][] = [{ kind: "full" }, { kind: "omitted" }]
    if (first.short !== undefined) forms.push({ kind: "short", lines: first.short })
    for (const tail of every(rest)) {
      for (const shown of forms) yield [{ section: first, shown }, ...tail]
    }
  }

  /** Which sections are kept, most important first: the thing ranked first. */
  const kept = (arrangement: Arrangement) =>
    arrangement.map(({ shown }) => shown.kind !== "omitted")
  /** The lists shown whole before the first shown short, or `null` when that is not a run. */
  function wholeRun(arrangement: Arrangement): number | null {
    const lists = arrangement.filter(
      ({ section, shown }) => section.short !== undefined && shown.kind !== "omitted",
    )
    const run = lists.findIndex(({ shown }) => shown.kind === "short")
    const length = run < 0 ? lists.length : run
    return lists.slice(length).every(({ shown }) => shown.kind === "short") ? length : null
  }
  function ranksAbove(a: Arrangement, b: Arrangement): boolean {
    const [keptA, keptB] = [kept(a), kept(b)]
    const differ = keptA.findIndex((value, index) => value !== keptB[index])
    if (differ >= 0) return keptA[differ] === true
    return (wholeRun(a) ?? -1) > (wholeRun(b) ?? -1)
  }

  it("keeps the most important sections it can, then shows whole the longest top run", () => {
    let seed = 20260924
    const random = () => {
      seed = (seed * 48271) % 2147483647
      return seed / 2147483647
    }
    for (let trial = 0; trial < 400; trial++) {
      const sections = Array.from({ length: 5 }, (_, index) => {
        const full = 1 + Math.floor(random() * 20)
        const short = full > 1 && random() < 0.6 ? 1 + Math.floor(random() * (full - 1)) : null
        return section(`s${index}`, full, short)
      })
      const budget = Math.floor(random() * sections.reduce((sum, s) => sum + s.lines.length, 0))
      const fits = (arrangement: Arrangement) => size(arrangement) <= budget

      let best: Arrangement | null = null
      for (const arrangement of every(sections)) {
        if (!fits(arrangement) || wholeRun(arrangement) === null) continue
        if (best === null || ranksAbove(arrangement, best)) best = arrangement
      }
      const kinds = (arrangement: Arrangement | null) =>
        arrangement?.map(({ shown }) => shown.kind) ?? null
      expect(kinds(arrangeWithin(sections, fits))).toEqual(kinds(best))
    }
  })
})
