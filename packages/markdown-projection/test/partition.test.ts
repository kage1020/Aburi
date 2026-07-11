import type { SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, fp, makeDiff, makeSymbol } from "./fixtures"

/**
 * §6.2 tail — `partition` routes overlapping delta flags by priority:
 *   apiChanged > logicChanged > syntaxChanged
 * A single `changed` entry lands in exactly one of API changes / Logic changes / Syntax-only.
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
  it("routes api+logic → API changes only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ apiChanged: true, logicChanged: true }))],
      }),
    )
    expect(md).toContain("## ⚠ API changes")
    expect(md).not.toContain("## 🔧 Logic changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })

  it("routes api+syntax → API changes only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ apiChanged: true, syntaxChanged: true }))],
      }),
    )
    expect(md).toContain("## ⚠ API changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })

  it("routes logic+syntax → Logic changes only", () => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta({ logicChanged: true, syntaxChanged: true }))],
      }),
    )
    expect(md).toContain("## 🔧 Logic changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
    expect(md).not.toContain("## ⚠ API changes")
  })

  it("routes api+logic+syntax → API changes only (top of the priority chain)", () => {
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
    expect(md).toContain("## ⚠ API changes")
    expect(md).not.toContain("## 🔧 Logic changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
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
    expect(md).not.toContain("## ⚠ API changes")
    expect(md).not.toContain("## 🔧 Logic changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })
})
