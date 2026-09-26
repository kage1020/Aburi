import { fp, makeSymbol } from "@aburi/test-support"
import type { SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, makeDiff } from "./fixtures"

/**
 * markdown-projection.md — `partition` routes overlapping delta flags by priority:
 *   apiChanged > logicChanged > confidenceChanged > syntaxChanged
 * A single `changed` entry lands in exactly one of API changes / Logic changes / Confidence
 * changes / Syntax-only.
 */

function makeDelta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: overrides.apiChanged ?? false,
    logicChanged: overrides.logicChanged ?? false,
    syntaxChanged: overrides.syntaxChanged ?? false,
    componentChanged: overrides.componentChanged ?? false,
    visibilityChanged: overrides.visibilityChanged ?? false,
    // Left out unless given, which is what a document written before the key existed carries.
    ...(overrides.confidenceChanged === undefined
      ? {}
      : { confidenceChanged: overrides.confidenceChanged }),
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
  confidence: "## 🎚 Confidence changes",
  syntax: "## 🎨 Syntax-only changes",
} as const

describe("partition — delta-priority routing (C4)", () => {
  it.each<[string, Partial<SymbolDelta>, keyof typeof SECTIONS | null]>([
    ["api+logic", { apiChanged: true, logicChanged: true }, "api"],
    ["api+syntax", { apiChanged: true, syntaxChanged: true }, "api"],
    ["logic+syntax", { logicChanged: true, syntaxChanged: true }, "logic"],
    ["api+logic+syntax", { apiChanged: true, logicChanged: true, syntaxChanged: true }, "api"],
    ["api+confidence", { apiChanged: true, confidenceChanged: true }, "api"],
    ["logic+confidence", { logicChanged: true, confidenceChanged: true }, "logic"],
    ["confidence+syntax", { confidenceChanged: true, syntaxChanged: true }, "confidence"],
    ["confidence alone", { confidenceChanged: true }, "confidence"],
    [
      "syntax, confidence written false",
      { syntaxChanged: true, confidenceChanged: false },
      "syntax",
    ],
    // An older document has no key at all; only an explicit `true` may route on it.
    ["syntax, confidence key absent", { syntaxChanged: true }, "syntax"],
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
