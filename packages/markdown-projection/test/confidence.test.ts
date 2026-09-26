import { makeSymbol } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { renderSymbolBlock } from "../src/component"
import { projectDiff } from "../src/diff"
import { projectSymbolExplain } from "../src/explain"
import { emptySummary, makeDiff } from "./fixtures"

/**
 * `Symbol.confidence` is specified to reach the reader as a badge (markdown-projection.md), and
 * the diff reports a Symbol whose confidence moved even when no fingerprint did. Before, the
 * badge was drawn on effect rows only, so a Symbol the machine was unsure of looked exactly
 * like one it was sure of everywhere outside the raw IR.
 */

const unsure = makeSymbol({
  id: "ts:src/x.controller.ts#XController",
  name: "XController",
  kind: "class",
  confidence: "medium",
})

function changed(before: IRSymbol, after: IRSymbol, delta: Partial<SymbolDelta>): SymbolChanged {
  return {
    status: "changed",
    before,
    after,
    delta: {
      apiChanged: false,
      logicChanged: false,
      syntaxChanged: false,
      componentChanged: false,
      visibilityChanged: false,
      confidenceChanged: true,
      ...delta,
    },
  }
}

function render(item: SymbolChanged): string {
  return projectDiff(makeDiff({ symbols: [item], summary: { ...emptySummary(), changed: 1 } }))
}

describe("a Symbol heading carries its confidence", () => {
  it("badges a medium Symbol on the component page", () => {
    expect(renderSymbolBlock(unsure)[0]).toBe("#### `XController` *(class)* ⚠ medium")
  })

  it("badges a low Symbol", () => {
    const low = { ...unsure, confidence: "low" as const }
    expect(renderSymbolBlock(low)[0]).toBe("#### `XController` *(class)* ⚠ low")
  })

  it("draws nothing for a high Symbol", () => {
    const sure = { ...unsure, confidence: "high" as const }
    expect(renderSymbolBlock(sure)[0]).toBe("#### `XController` *(class)*")
  })

  it("badges the explain title", () => {
    expect(projectSymbolExplain(unsure).split("\n")[0]).toBe("# `XController` *(class)* ⚠ medium")
  })

  it("badges a Symbol listed whole in diff.md", () => {
    const md = projectDiff(
      makeDiff({
        symbols: [{ status: "added", symbol: unsure }],
        summary: { ...emptySummary(), added: 1 },
      }),
    )
    expect(md).toContain("### `XController` *(class)* ⚠ medium")
  })
})

describe("diff.md reports a confidence change", () => {
  const sure = { ...unsure, confidence: "high" as const }

  it("gives a confidence-only change its own section, with before and after", () => {
    const md = render(changed(sure, unsure, {}))

    expect(md).toContain("## 🎚 Confidence changes")
    expect(md).toContain("### `XController` *(class)* ⚠ medium")
    expect(md).toContain("- confidence: `high` → `medium`")
    expect(md).not.toContain("## ⚠ API changes")
    expect(md).not.toContain("fingerprint changed; no field-level detail")
  })

  it("keeps a change that also moved the API in the API section, with the confidence row", () => {
    const md = render(changed(sure, unsure, { apiChanged: true }))

    expect(md).toContain("## ⚠ API changes")
    expect(md).toContain("- confidence: `high` → `medium`")
    expect(md).not.toContain("## 🎚 Confidence changes")
  })

  it("lifts a syntax change out of the folded section, where the before and after would not show", () => {
    const md = render(changed(sure, unsure, { syntaxChanged: true }))

    expect(md).toContain("## 🎚 Confidence changes")
    expect(md).not.toContain("## 🎨 Syntax-only changes")
  })

  it("says nothing about confidence for a diff written before the field existed", () => {
    const { confidenceChanged: _, ...older } = changed(sure, sure, { logicChanged: true }).delta
    const md = render({ status: "changed", before: sure, after: sure, delta: older })

    expect(md).not.toContain("confidence")
    expect(md).toContain("## 🔧 Logic changes")
  })
})
