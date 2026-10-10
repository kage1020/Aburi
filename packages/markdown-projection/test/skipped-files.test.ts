import { makeIR, makeSymbol, sliceId, symbolId } from "@aburi/test-support"
import type { IR, NotComparedFile, SymbolUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff, projectWorkspace } from "../src"
import { makeDiff, projectChanges } from "./fixtures"
import { sectionOf } from "./markdown"

function unknown(overrides: Partial<SymbolUnknown> = {}): SymbolUnknown {
  return {
    status: "unknown",
    symbol: makeSymbol({ id: "ts:src/gone.ts#handleRequest", name: "handleRequest" }),
    absentFrom: "head",
    reason: "parse-failed",
    ...overrides,
  }
}

const billing = makeSymbol({ id: "ts:src/big.ts#Billing", name: "Billing" })

describe("projectDiff — the Unknown section", () => {
  it("names the Symbol, the side that lost the file, and why", () => {
    const md = projectChanges([unknown()])
    expect(sectionOf(md, "## ❔ Unknown").slice(0, 5)).toEqual([
      "## ❔ Unknown",
      "",
      "### `handleRequest` *(function)*",
      "**File**: `src/gone.ts:1`",
      "**Why**: the head scan skipped `src/gone.ts` (parse-failed), so this Symbol may still exist",
    ])
  })

  it.each<[string, Partial<SymbolUnknown>, string]>([
    [
      "a Symbol the base never read as one that may not be new",
      { absentFrom: "base", reason: "parse-timeout" },
      "the base scan skipped `src/gone.ts` (parse-timeout), so this Symbol may not be new",
    ],
    [
      "the path the head recorded when git renamed the file",
      { symbol: billing, reason: "over-size", lostPath: "src/billing.ts" },
      "the head scan skipped this file under its head name, `src/billing.ts` (over-size), so this Symbol may still exist",
    ],
    [
      "the path the base recorded when git renamed the file",
      {
        symbol: makeSymbol({ id: "ts:src/billing.ts#Billing", name: "Billing" }),
        absentFrom: "base",
        reason: "parse-timeout",
        lostPath: "src/big.ts",
      },
      "the base scan skipped this file under its base name, `src/big.ts` (parse-timeout), so this Symbol may not be new",
    ],
  ])("explains %s", (_, overrides, why) => {
    expect(projectChanges([unknown(overrides)])).toContain(`**Why**: ${why}\n`)
  })

  it("names the renamed path in the Slice View too, where the member line shows the other", () => {
    const md = projectDiff(
      makeDiff({
        symbols: [
          unknown({ symbol: billing, reason: "over-size", lostPath: "src/billing.ts" }),
          unknown(),
        ],
        slices: [
          {
            id: sliceId("slice:ts:src/big.ts#Billing"),
            members: [symbolId("ts:src/big.ts#Billing"), symbolId("ts:src/gone.ts#handleRequest")],
          },
        ],
      }),
    )
    expect(md).toContain(
      "↳ unknown: the head scan skipped this file under its head name, `src/billing.ts` (over-size)",
    )
    expect(md).toContain("↳ unknown: the head scan skipped this file (parse-failed)")
  })
})

describe("projectDiff — the Not compared section", () => {
  function notCompared(...files: NotComparedFile[]): string {
    return projectDiff(makeDiff({ notCompared: files }))
  }

  it.each<[string, NotComparedFile, string]>([
    [
      "what each revision said about a file",
      { path: "vendor/huge.ts", baseReason: "parse-timeout", headReason: "over-size" },
      "- `vendor/huge.ts` — parse-timeout at base, over-size at head",
    ],
    [
      "a reason both revisions gave once",
      { path: "vendor/bundle.js", baseReason: "over-size", headReason: "over-size" },
      "- `vendor/bundle.js` — over-size on both",
    ],
    [
      "a renamed file by both its paths",
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
      "- `src/big.ts` → `src/billing.ts` — over-size on both",
    ],
  ])("names %s", (_, file, row) => {
    expect(sectionOf(notCompared(file), "## 🚫 Not compared")).toEqual([
      "## 🚫 Not compared",
      "",
      row,
      "",
    ])
  })

  it("sits beside Unknown rather than inside it", () => {
    const md = projectDiff(
      makeDiff({
        symbols: [unknown()],
        notCompared: [{ path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" }],
      }),
    )
    expect(sectionOf(md, "## ❔ Unknown").join("\n")).not.toContain("vendor/huge.ts")
    expect(sectionOf(md, "## 🚫 Not compared").join("\n")).not.toContain("handleRequest")
  })

  it("is left out when the comparison covered everything, or the diff predates the field", () => {
    const { notCompared: _absent, ...older } = makeDiff()
    expect(notCompared()).not.toContain("Not compared")
    expect(projectDiff(older)).not.toContain("Not compared")
  })
})

describe("projectWorkspace — the files not analysed", () => {
  function irWith(stats: Partial<IR["stats"]>): IR {
    const base = makeIR()
    return { ...base, stats: { ...base.stats, totalFiles: 4, parsedFiles: 1, ...stats } }
  }

  it("groups the paths by reason, under a count of how much went missing", () => {
    const md = projectWorkspace(
      irWith({
        skippedFiles: [
          { path: "src/a.ts", reason: "parse-failed" },
          { path: "vendor/huge.ts", reason: "over-size" },
          { path: "src/b.ts", reason: "parse-failed" },
        ],
      }),
    )
    expect(sectionOf(md, "## Files not analysed")).toEqual([
      "## Files not analysed",
      "",
      "3 of 4 file(s) produced no Symbols.",
      "",
      "- **over-size** (1):",
      "  - `vendor/huge.ts`",
      "- **parse-failed** (2):",
      "  - `src/a.ts`",
      "  - `src/b.ts`",
      "",
    ])
  })

  it.each<[string, Partial<IR["stats"]>]>([
    ["the scan lost nothing", { totalFiles: 1, parsedFiles: 1, skippedFiles: [] }],
    ["the IR predates the field, rather than claiming a clean run", {}],
  ])("is left out when %s", (_, stats) => {
    expect(projectWorkspace(irWith(stats))).not.toContain("Files not analysed")
  })

  it("says so in the header when files went missing and cannot be named", () => {
    expect(projectWorkspace(irWith({}))).toContain("(across 1 of 4 files; 3 produced no Symbols)")
  })

  it("keeps the plain header for a scan that parsed everything", () => {
    expect(projectWorkspace(irWith({ totalFiles: 4, parsedFiles: 4 }))).toContain(
      "(across 4 files)",
    )
  })
})
