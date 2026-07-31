import type { UnresolvedCallDiagnostic } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectSymbolExplain } from "../src/explain"
import { makeSymbol, symbolId } from "./fixtures"

// call-resolution.md §8.1 — `aburi explain --debug-resolution` renders the
// per-Symbol dump the doc promises. The buckets never enter the IR, so they
// arrive through the projection context instead.

const CALLER_ID = symbolId("ts:src/ctl.ts#Ctl.route")

function caller() {
  return makeSymbol({
    id: CALLER_ID,
    name: "Ctl.route",
    calls: [
      { target: "svc.refund", line: 12, resolved: symbolId("ts:src/svc.ts#Svc.refund") },
      { target: "factory.save", line: 14, resolved: null },
      { target: "User.save", line: 16, resolved: null },
    ],
  })
}

const diagnostics: UnresolvedCallDiagnostic[] = [
  { symbolId: CALLER_ID, target: "factory.save", line: 14, bucket: "dynamic", candidates: [] },
  {
    symbolId: CALLER_ID,
    target: "User.save",
    line: 16,
    bucket: "ambiguous",
    candidates: ["ts:src/a.ts#User.save", "ts:src/b.ts#User.save"].map(symbolId),
  },
]

describe("projectSymbolExplain — ## Call resolution", () => {
  it("renders one row per call site with the resolved callee or the bucket", () => {
    const md = projectSymbolExplain(caller(), { unresolvedCalls: diagnostics })
    expect(md).toContain("## Call resolution")
    expect(md).toContain("| 12 | `svc.refund` | `ts:src/svc.ts#Svc.refund` | — | — |")
    expect(md).toContain("| 14 | `factory.save` | — | `dynamic` | — |")
    expect(md).toContain(
      "| 16 | `User.save` | — | `ambiguous` | `ts:src/a.ts#User.save`<br>`ts:src/b.ts#User.save` |",
    )
  })

  it("orders rows by line so they read alongside the source", () => {
    const md = projectSymbolExplain(caller(), { unresolvedCalls: diagnostics })
    const section = md.slice(md.indexOf("## Call resolution"))
    expect(section.indexOf("| 12 |")).toBeLessThan(section.indexOf("| 14 |"))
    expect(section.indexOf("| 14 |")).toBeLessThan(section.indexOf("| 16 |"))
  })

  it("ignores diagnostics belonging to other Symbols", () => {
    const md = projectSymbolExplain(caller(), {
      unresolvedCalls: [
        {
          symbolId: symbolId("ts:src/other.ts#other"),
          target: "factory.save",
          line: 14,
          bucket: "no-match",
          candidates: [],
        },
      ],
    })
    expect(md).toContain("| 14 | `factory.save` | — | — | — |")
    expect(md).not.toContain("no-match")
  })

  it("says so explicitly when the Symbol has no call sites", () => {
    const md = projectSymbolExplain(makeSymbol({ id: CALLER_ID, name: "Ctl.route" }), {
      unresolvedCalls: [],
    })
    expect(md).toContain("## Call resolution")
    expect(md).toContain("_(no call sites)_")
  })

  it("leaves the default output byte-identical when no diagnostics are supplied", () => {
    const withoutContext = projectSymbolExplain(caller())
    const withDependenciesOnly = projectSymbolExplain(caller(), { dependencies: [] })
    expect(withoutContext).not.toContain("Call resolution")
    expect(withDependenciesOnly).toBe(withoutContext)
  })
})
