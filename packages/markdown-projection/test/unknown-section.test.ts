import type { Dependency, IR, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff, projectWorkspace } from "../src"
import { emptySummary, endpoint, languageId, makeDiff, makeSymbol } from "./fixtures"

/**
 * The two documents a human reads have to say what the scan lost, or the exit code is the
 * only signal and an exit code does not travel with the artifact.
 */

function unknown(overrides: Partial<SymbolUnknown> = {}): SymbolUnknown {
  return {
    status: "unknown",
    symbol: makeSymbol({ id: "ts:src/gone.ts#handleRequest", name: "handleRequest" }),
    absentFrom: "head",
    reason: "parse-failed",
    ...overrides,
  }
}

describe("projectDiff — the Unknown section", () => {
  it("names the Symbol, the side that lost the file, and why", () => {
    const md = projectDiff(
      makeDiff({ symbols: [unknown()], summary: { ...emptySummary(), unknown: 1 } }),
    )
    expect(md).toContain("## ❔ Unknown")
    expect(md).toContain("`handleRequest`")
    expect(md).toContain("the head scan skipped `src/gone.ts` (parse-failed)")
    expect(md).toContain("may still exist")
  })

  it("reads the other direction as 'may not be new'", () => {
    const md = projectDiff(
      makeDiff({
        symbols: [unknown({ absentFrom: "base", reason: "parse-timeout" })],
        summary: { ...emptySummary(), unknown: 1 },
      }),
    )
    expect(md).toContain("the base scan skipped `src/gone.ts` (parse-timeout)")
    expect(md).toContain("may not be new")
  })

  it("qualifies the summary line, so the counts beside it are not read as complete", () => {
    const md = projectDiff(
      makeDiff({ symbols: [unknown()], summary: { ...emptySummary(), removed: 2, unknown: 1 } }),
    )
    expect(md).toContain("-2 removed")
    expect(md).toContain("?1 unknown")
  })

  it("leaves the summary line alone when there are none", () => {
    // The line is skimmed on every PR; a permanent `?0` is noise on the overwhelming
    // majority of diffs where nothing was lost.
    const md = projectDiff(makeDiff({ summary: { ...emptySummary(), removed: 2 } }))
    expect(md).not.toContain("unknown")
    expect(md).not.toContain("## ❔")
  })
})

describe("projectDiff — the Not compared section", () => {
  it("names each file and what each revision said about it", () => {
    const md = projectDiff(
      makeDiff({
        notCompared: [
          { path: "vendor/huge.ts", baseReason: "parse-timeout", headReason: "over-size" },
        ],
      }),
    )
    expect(md).toContain("## 🚫 Not compared")
    expect(md).toContain("`vendor/huge.ts`")
    expect(md).toContain("parse-timeout at base, over-size at head")
  })

  it("says it once when both revisions gave the same reason", () => {
    const md = projectDiff(
      makeDiff({
        notCompared: [
          { path: "vendor/bundle.js", baseReason: "over-size", headReason: "over-size" },
        ],
      }),
    )
    expect(md).toContain("`vendor/bundle.js` — over-size on both")
  })

  it("sits beside Unknown rather than inside it", () => {
    // Both are gaps rather than changes, and a reader scanning for what the diff does not
    // cover should find them together — but who can close them differs, so they are not one
    // section.
    const md = projectDiff(
      makeDiff({
        symbols: [unknown()],
        summary: { ...emptySummary(), unknown: 1 },
        notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" }],
      }),
    )
    const unknownAt = md.indexOf("## ❔ Unknown")
    const notComparedAt = md.indexOf("## 🚫 Not compared")
    expect(unknownAt).toBeGreaterThan(-1)
    expect(notComparedAt).toBeGreaterThan(unknownAt)
    expect(md.slice(unknownAt, notComparedAt)).toContain("handleRequest")
    expect(md.slice(unknownAt, notComparedAt)).not.toContain("vendor/huge.ts")
  })

  it("omits the section when the comparison covered everything", () => {
    expect(projectDiff(makeDiff({ notCompared: [] }))).not.toContain("Not compared")
  })

  it("omits it for a document that predates the field, rather than claiming a clean run", () => {
    // An older diff cannot say what it missed. Rendering the section over `?? []` would report
    // "nothing was missed" on every archived document, which is the claim this whole field
    // exists to stop making.
    const { notCompared: _absent, ...older } = makeDiff({ notCompared: [] })
    expect(projectDiff(older)).not.toContain("Not compared")
  })
})

describe("projectDiff — the Unknown dependency group", () => {
  const edge: Dependency = {
    from: endpoint("ts:src/gone.ts#handleRequest"),
    to: endpoint("ts:src/kept.ts#log"),
    via: "call",
    direction: "outbound",
    effect: null,
  }

  it("names the edge, the side that lost the file, and why", () => {
    const md = projectDiff(
      makeDiff({
        dependencies: {
          added: [],
          removed: [],
          unknown: [
            {
              dependency: { ...edge },
              absentFrom: "head",
              lostFiles: [{ path: "src/gone.ts", reason: "parse-failed" }],
            },
          ],
        },
        summary: { ...emptySummary(), depsUnknown: 1 },
      }),
    )
    expect(md).toContain("## 🔗 Dependency changes")
    expect(md).toContain("### Unknown — the other revision never read one end")
    expect(md).toContain(
      "- `ts:src/gone.ts#handleRequest` → `ts:src/kept.ts#log` (via `call`) — " +
        "the head scan skipped `src/gone.ts` (parse-failed)",
    )
  })

  it("keeps the unknown edge out of the group a reviewer reads as deletions", () => {
    // With `removed: []` the absence of `### Symbol-level removed` proves nothing — the
    // assertion could not fail whatever the projection did. A real removal has to be present
    // for "it did not land in there" to be a claim about anything.
    const deleted: Dependency = {
      from: endpoint("ts:src/a.ts#caller"),
      to: endpoint("ts:src/b.ts#callee"),
      via: "call",
      direction: "outbound",
      effect: null,
    }
    const md = projectDiff(
      makeDiff({
        dependencies: {
          added: [
            { ...deleted, from: endpoint("billing"), to: endpoint("payments"), via: "import" },
          ],
          removed: [deleted],
          unknown: [
            {
              dependency: { ...edge },
              absentFrom: "head",
              lostFiles: [{ path: "src/gone.ts", reason: "parse-failed" }],
            },
          ],
        },
        summary: { ...emptySummary(), depsAdded: 1, depsRemoved: 1, depsUnknown: 1 },
      }),
    )
    const removedSection = md.slice(
      md.indexOf("### Symbol-level removed"),
      md.indexOf("### Unknown"),
    )
    expect(removedSection).toContain("`ts:src/a.ts#caller`")
    expect(removedSection).not.toContain("handleRequest")
    // And the four level groups plus Unknown coexist, Unknown last.
    expect(md.indexOf("### Component-level added")).toBeLessThan(md.indexOf("### Unknown"))
  })

  it("names both files when the two endpoints went for different reasons", () => {
    const md = projectDiff(
      makeDiff({
        dependencies: {
          added: [],
          removed: [],
          unknown: [
            {
              dependency: { ...edge },
              absentFrom: "base",
              lostFiles: [
                { path: "src/also.ts", reason: "parse-timeout" },
                { path: "src/gone.ts", reason: "over-size" },
              ],
            },
          ],
        },
        summary: { ...emptySummary(), depsUnknown: 1 },
      }),
    )
    expect(md).toContain(
      "the base scan skipped `src/also.ts` (parse-timeout), `src/gone.ts` (over-size)",
    )
  })

  it("omits the group when nothing is unknown, and for a diff that predates the field", () => {
    expect(projectDiff(makeDiff())).not.toContain("never read one end")
    expect(projectDiff(makeDiff({ dependencies: { added: [], removed: [] } }))).not.toContain(
      "never read one end",
    )
  })
})

describe("projectWorkspace — the files not analysed", () => {
  function irWith(stats: Partial<IR["stats"]>): IR {
    return {
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      generator: { name: "aburi", version: "0.0.0", plugins: [] },
      workspace: { root: ".", managers: [], languages: [languageId("ts")] },
      components: [],
      symbols: [],
      dependencies: [],
      stats: {
        totalFiles: 4,
        parsedFiles: 1,
        keptSymbols: 0,
        droppedSymbols: 0,
        effectPropagation: {
          sccCount: 0,
          maxSccSize: 0,
          propagatedEffectCount: 0,
          symbolsWithPropagatedEffects: 0,
        },
        ...stats,
      },
    } as IR
  }

  it("groups the paths by reason, under a count of how much went missing", () => {
    const md = projectWorkspace(
      irWith({
        skippedFiles: [
          { path: "src/a.ts", reason: "parse-failed" },
          { path: "src/b.ts", reason: "parse-failed" },
          { path: "vendor/huge.ts", reason: "over-size" },
        ],
      }),
    )
    expect(md).toContain("## Files not analysed")
    expect(md).toContain("3 of 4 file(s) produced no Symbols.")
    expect(md).toContain("- **parse-failed** (2):")
    expect(md).toContain("  - `src/a.ts`")
    expect(md).toContain("- **over-size** (1):")
  })

  it("omits the section when the document lost nothing", () => {
    const md = projectWorkspace(irWith({ totalFiles: 1, parsedFiles: 1 }))
    expect(md).not.toContain("Files not analysed")
  })

  it("omits it for a document that predates the field, rather than claiming a clean run", () => {
    // `totalFiles > parsedFiles` with no list: the writer could not say. Rendering an empty
    // section would read as "nothing was lost", which is the opposite of what it knows.
    const md = projectWorkspace(irWith({}))
    expect(md).not.toContain("Files not analysed")
  })

  it("says so in the header when files went missing and cannot be named", () => {
    // The section above is the only other place this would show, and it is correctly absent.
    // Without the header saying it, a document that lost three files renders byte-identically
    // to a clean scan of the same workspace — and a pure projection has no stderr to fall
    // back on the way `aburi diff` does.
    expect(projectWorkspace(irWith({}))).toContain("(across 1 of 4 files; 3 produced no Symbols)")
  })

  it("keeps the plain header for a scan that parsed everything", () => {
    expect(projectWorkspace(irWith({ totalFiles: 4, parsedFiles: 4 }))).toContain(
      "(across 4 files)",
    )
  })
})
