import { fp, makeSymbol } from "@aburi/test-support"
import type { SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, makeDiff } from "./fixtures"

/**
 * markdown-projection.md — `partition` routes overlapping delta flags by priority:
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

const SECTIONS = {
  api: "## ⚠ API changes",
  logic: "## 🔧 Logic changes",
  syntax: "## 🎨 Syntax-only changes",
} as const

describe("partition — delta-priority routing (C4)", () => {
  it.each<[string, Partial<SymbolDelta>, keyof typeof SECTIONS | null]>([
    ["api+logic", { apiChanged: true, logicChanged: true }, "api"],
    ["api+syntax", { apiChanged: true, syntaxChanged: true }, "api"],
    ["logic+syntax", { logicChanged: true, syntaxChanged: true }, "logic"],
    ["api+logic+syntax", { apiChanged: true, logicChanged: true, syntaxChanged: true }, "api"],
    // Every axis false should be `unchanged` upstream; if it slips through, no section may fire.
    ["no axis", {}, null],
  ])("routes %s to exactly one section", (_, flags, expected) => {
    const md = projectDiff(
      makeDiff({
        summary: { ...emptySummary(), changed: 1 },
        symbols: [makeChangedEntry(makeDelta(flags))],
      }),
    )
    for (const [key, heading] of Object.entries(SECTIONS)) {
      if (key === expected) expect(md).toContain(heading)
      else expect(md).not.toContain(heading)
    }
  })
})
