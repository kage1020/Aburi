import type { IR, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff, projectWorkspace } from "../src"
import { emptySummary, languageId, makeDiff, makeSymbol } from "./fixtures"

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

describe("projectWorkspace — the files not analysed", () => {
  function irWith(stats: Partial<IR["stats"]>): IR {
    return {
      $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
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
