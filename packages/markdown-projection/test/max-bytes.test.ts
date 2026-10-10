import type { SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { changed, emptySummary, makeDiff, moved, relocated, symbolWithBody } from "./fixtures"
import { bytes, headings, noteOf } from "./markdown"

const GITHUB_LIMIT = 65536

/** A diff that fills seven sections, one of them as long as `addedCount` asks. */
function crowdedDiff(addedCount: number) {
  const movedOne = symbolWithBody("MovedOne")
  const toggled = symbolWithBody("ToggledOne")
  const symbols: SymbolChange[] = [
    ...Array.from({ length: addedCount }, (_, i) => ({
      status: "added" as const,
      symbol: symbolWithBody(`Added${String(i).padStart(4, "0")}`),
    })),
    changed(symbolWithBody("ApiOne"), { apiChanged: true }),
    changed(symbolWithBody("LogicOne"), { logicChanged: true }),
    changed(symbolWithBody("SyntaxOne"), { syntaxChanged: true }),
    changed(symbolWithBody("ConfidenceOne"), { confidenceChanged: true }, { confidence: "medium" }),
    moved(movedOne, relocated(movedOne, "src/moved/MovedOne.ts"), "id-match"),
    {
      status: "dropped-toggled",
      before: toggled,
      after: { ...toggled, dropped: true, dropReason: "pure DTO" },
      direction: "to-dropped",
    },
  ]
  return makeDiff({
    summary: { ...emptySummary(), added: addedCount, changed: 4, moved: 1, droppedToggled: 1 },
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

  it("leaves a document that already fits byte-identical, with no note to point anywhere", () => {
    const small = crowdedDiff(2)
    const uncapped = projectDiff(small)
    expect(bytes(uncapped)).toBeLessThan(GITHUB_LIMIT)
    expect(
      projectDiff(small, { maxBytes: GITHUB_LIMIT, fullReportLocation: "`diff.full.md`" }),
    ).toBe(uncapped)
  })

  it("keeps what fits below a section too large to fit even as names", () => {
    const md = projectDiff(crowdedDiff(400), { maxBytes: 2000 })
    expect(headings(md)).toEqual([
      "## ⚠ API changes",
      "## 🔧 Logic changes",
      "## 🔀 Moved",
      "## 💧 Dropped changes",
      "## 🎚 Confidence changes",
      "## 🎨 Syntax-only changes",
    ])
    expect(noteOf(md)).toBe(
      "> ⚠ **1 section was omitted** to keep this report within 2000 bytes: ➕ Added. The full report is the same diff rendered without a size cap.",
    )
  })

  it("drops only what the budget requires", () => {
    const movedOne = symbolWithBody("MovedOne")
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 301, moved: 1 },
      symbols: [
        changed(symbolWithBody("ApiOne"), { apiChanged: true }),
        moved(movedOne, relocated(movedOne, "src/moved/MovedOne.ts"), "id-match"),
        ...Array.from({ length: 300 }, (_, i) =>
          changed(symbolWithBody(`Syntax${String(i).padStart(4, "0")}`), { syntaxChanged: true }),
        ),
      ],
    })
    const md = projectDiff(diff, { maxBytes: 4000 })
    expect(md).toContain("**1 section was omitted**")
    expect(md).toContain("## ⚠ API changes")
    expect(md).toContain("## 🔀 Moved")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })

  it("keeps the ordinary wording when nothing is left but the document still fits", () => {
    const diff = crowdedDiff(400)
    const floor = bytes(projectDiff(diff, { maxBytes: 1 }))
    const md = projectDiff(diff, { maxBytes: floor })
    expect(headings(md)).toEqual([])
    expect(bytes(md)).toBeLessThanOrEqual(floor)
    expect(md).toContain(`to keep this report within ${floor} bytes`)
    expect(md).not.toContain("could not be brought")
  })

  it("says it is over budget even when there is no section to drop", () => {
    const md = projectDiff(makeDiff(), { maxBytes: 1 })
    expect(noteOf(md)).toBe("> ⚠ This report could not be brought within 1 bytes.")
  })

  it("names where the full report is", () => {
    const md = projectDiff(crowdedDiff(400), {
      maxBytes: GITHUB_LIMIT,
      fullReportLocation: "`diff.full.md` beside `diff.md`",
    })
    expect(noteOf(md)).toMatch(
      /The full report, the same diff without a size cap, is `diff\.full\.md` beside `diff\.md`\.$/,
    )
  })

  it.each([
    "one\ntwo",
    "one\rtwo",
  ])("refuses a full report location that would break the note (%j)", (fullReportLocation) => {
    expect(() =>
      projectDiff(crowdedDiff(1), { maxBytes: GITHUB_LIMIT, fullReportLocation }),
    ).toThrow(RangeError)
  })

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects a budget of %s, which is not a positive integer", (maxBytes) => {
    expect(() => projectDiff(crowdedDiff(1), { maxBytes })).toThrow(RangeError)
  })
})

describe("projectDiff — maxBytes at a budget nothing fits", () => {
  const md = projectDiff(crowdedDiff(400), { maxBytes: 1 })

  it("keeps the title and the Summary", () => {
    expect(md).toContain("# Aburi diff: main..HEAD")
    expect(md).toContain("**Summary**: +400 added")
    expect(headings(md)).toEqual([])
  })

  it("names every section it dropped, in the order the document would have shown them", () => {
    expect(noteOf(md)).toContain("**7 sections were omitted**")
    expect(noteOf(md)).toContain(
      ": ⚠ API changes, 🔧 Logic changes, ➕ Added, 🔀 Moved, 💧 Dropped changes, 🎚 Confidence changes, 🎨 Syntax-only changes.",
    )
    expect(noteOf(md)).not.toContain("names only")
  })

  it("says it could not fit, rather than claiming a budget it missed", () => {
    expect(bytes(md)).toBeGreaterThan(1)
    expect(md).toContain("could not be brought within 1 bytes")
    expect(md).not.toContain("to keep this report within 1 bytes")
  })
})

describe("projectDiff — maxBytes at every budget", () => {
  const diff = crowdedDiff(40)
  const full = projectDiff(diff)
  const budgets = Array.from(
    { length: Math.ceil(bytes(full) / 97) },
    (_, i) => bytes(full) - i * 97,
  )
  const capped = budgets.map((budget) => ({ budget, md: projectDiff(diff, { maxBytes: budget }) }))

  it("keeps what it keeps in document order and within the budget", () => {
    const order = headings(full)
    expect(order.length).toBeGreaterThan(1)
    for (const { budget, md } of capped) {
      const kept = headings(md)
      expect(kept).toEqual(order.filter((heading) => kept.includes(heading)))
      // Over budget is allowed only on the one path that cannot do better: nothing kept.
      if (kept.length > 0) expect(bytes(md)).toBeLessThanOrEqual(budget)
    }
    expect(headings(capped[0]?.md ?? "")).toEqual(order)
  })

  it("never cuts a `<details>` block in half", () => {
    expect(full).toContain("<details>")
    for (const { md } of capped) {
      expect(md.split("<details>").length).toBe(md.split("</details>").length)
    }
  })
})
