import type {
  Symbol as IRSymbol,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { call, emptySummary, fp, makeDiff, makeSymbol, rule } from "./fixtures"

/**
 * §6.4 — `maxBytes`. The document GitHub takes as a PR comment body has a 65536-byte
 * ceiling, and `projectDiff` used to emit whatever the diff was worth: roughly 210 bytes
 * per added symbol, so a pull request adding ~310 symbols produced a body the API rejected
 * with a 422 and nothing was posted at all.
 */

const GITHUB_LIMIT = 65536

function bytes(markdown: string): number {
  return Buffer.byteLength(markdown, "utf8")
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

describe("projectDiff — maxBytes (§6.4)", () => {
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

  it("drops sections from the least important end, at every budget", () => {
    // Whatever survives is a prefix of the document's own importance order: the cut only ever
    // moves up from the bottom, so the reader never loses an API change while a refactor stays.
    const diff = crowdedDiff(40)
    const order = headings(projectDiff(diff))
    const full = bytes(projectDiff(diff))
    for (let budget = full; budget > 0; budget -= 97) {
      const kept = headings(projectDiff(diff, { maxBytes: budget }))
      expect(kept).toEqual(order.slice(0, kept.length))
    }
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
    const md = projectDiff(crowdedDiff(400), { maxBytes: 2000 })
    const note = md.split("\n").find((line) => line.startsWith("> ⚠"))
    expect(note).toBeDefined()
    expect(note).toContain("sections were omitted")
    expect(note).toContain("2000 bytes")
    const moved = note?.indexOf("🔀 Moved") ?? -1
    const dropped = note?.indexOf("💧 Dropped changes") ?? -1
    const syntax = note?.indexOf("🎨 Syntax-only changes") ?? -1
    expect(moved).toBeGreaterThanOrEqual(0)
    expect(moved).toBeLessThan(dropped)
    expect(dropped).toBeLessThan(syntax)
  })

  it("never cuts a `<details>` block in half", () => {
    // Every budget from "everything fits" down to "nothing does" leaves the folds balanced.
    const diff = crowdedDiff(40)
    const full = bytes(projectDiff(diff))
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
