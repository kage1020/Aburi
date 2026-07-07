import type { SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, fp, makeDiff, makeSymbol } from "./fixtures"

/**
 * §6.2 tail — `partition` routes overlapping delta flags by priority:
 *   apiChanged > logicChanged > syntaxChanged
 * A single `changed` entry lands in exactly one of API 変更 / Logic 変更 / Syntax-only.
 */

function makeDelta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: overrides.apiChanged ?? false,
    logicChanged: overrides.logicChanged ?? false,
    syntaxChanged: overrides.syntaxChanged ?? false,
    componentChanged: overrides.componentChanged ?? false,
    visibilityChanged: overrides.visibilityChanged ?? false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
  }
}

function makeChangedEntry(delta: SymbolDelta): SymbolChanged {
  const before = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp("v1") })
  return {
    status: "changed",
    before,
    after: { ...before, fingerprint: fp("v2") },
    delta,
  }
}

describe("partition — delta-priority routing (C4)", () => {
  it("routes api+logic → API 変更 only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ apiChanged: true, logicChanged: true }))],
      }),
    )
    expect(md).toContain("## ⚠ API 変更")
    expect(md).not.toContain("## 🔧 Logic 変更")
    expect(md).not.toContain("## 🎨 Syntax-only 変更")
  })

  it("routes api+syntax → API 変更 only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ apiChanged: true, syntaxChanged: true }))],
      }),
    )
    expect(md).toContain("## ⚠ API 変更")
    expect(md).not.toContain("## 🎨 Syntax-only 変更")
  })

  it("routes logic+syntax → Logic 変更 only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ logicChanged: true, syntaxChanged: true }))],
      }),
    )
    expect(md).toContain("## 🔧 Logic 変更")
    expect(md).not.toContain("## 🎨 Syntax-only 変更")
    expect(md).not.toContain("## ⚠ API 変更")
  })

  it("routes api+logic+syntax → API 変更 only (top of the priority chain)", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [
          makeChangedEntry(
            makeDelta({ apiChanged: true, logicChanged: true, syntaxChanged: true }),
          ),
        ],
      }),
    )
    expect(md).toContain("## ⚠ API 変更")
    expect(md).not.toContain("## 🔧 Logic 変更")
    expect(md).not.toContain("## 🎨 Syntax-only 変更")
  })

  it("emits nothing for a `changed` entry where every axis is false", () => {
    // (This should be treated as `unchanged` upstream; if it slips through the routing
    //  must not accidentally emit a section.)
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta())],
      }),
    )
    expect(md).not.toContain("## ⚠ API 変更")
    expect(md).not.toContain("## 🔧 Logic 変更")
    expect(md).not.toContain("## 🎨 Syntax-only 変更")
  })
})
