import {
  component,
  dependency,
  effect,
  makeIR,
  makeSymbol,
  sliceId,
  symbolId,
  zeroFp,
} from "@aburi/test-support"
import type { SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectComponent, projectWorkspace } from "../src"
import { projectDiff } from "../src/diff"
import { makeDiff } from "./fixtures"

function expectPastSpreadLimit(lines: readonly string[]): void {
  expect(() => {
    const probe: string[] = []
    probe.push(...lines)
  }).toThrow(RangeError)
}

/** The lines of the section `heading` opens, up to the next `## ` heading. */
function sectionOf(md: string, heading: string): string[] {
  const lines = md.split("\n")
  const start = lines.indexOf(heading)
  if (start === -1) throw new Error(`no ${heading} section`)
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "))
  return lines.slice(start, end === -1 ? undefined : end)
}

const symbolAt = (i: number) =>
  makeSymbol({ id: `ts:src/d${i % 30}/m${i}.ts#f${i}`, name: `f${i}` })

describe("projections of workspace-sized lists", () => {
  it("renders a component page of 40,000 Symbols", () => {
    const symbols = Array.from({ length: 40_000 }, (_, i) => symbolAt(i))
    const md = projectComponent({
      component: component({ id: "app", name: "App" }),
      symbols,
      dependencies: [],
    })

    expect(md).toContain("`f39999`")
    // No Symbol here is a boundary, so this case guards the Symbols section alone.
    expect(md).not.toContain("## Boundary effect surface")
    expectPastSpreadLimit(sectionOf(md, "## Symbols"))
  })

  it("renders a boundary effect surface of 200,000 Symbols", { timeout: 30_000 }, () => {
    const reads = [effect({ id: "db.read", target: "db.user.find", plugin: "effects-prisma" })]
    const symbols = Array.from({ length: 200_000 }, (_, i) =>
      makeSymbol({
        id: `ts:src/routes.ts#f${i}`,
        name: `f${i}`,
        extKind: "framework:acme:route",
        effects: reads,
        fingerprint: zeroFp(),
      }),
    )
    const md = projectComponent({
      component: component({ id: "app", name: "App" }),
      symbols,
      dependencies: [],
    })

    expect(md).toContain("- `f199999` — db.read(`db.user.find`)")
    expectPastSpreadLimit(sectionOf(md, "## Boundary effect surface"))
  })

  it("renders a workspace page that skipped 200,000 files", () => {
    const skippedFiles = Array.from({ length: 200_000 }, (_, i) => ({
      path: `vendor/f${i}.ts`,
      reason: "parse-failed" as const,
    }))
    const base = makeIR()
    const md = projectWorkspace({
      ...base,
      stats: { ...base.stats, totalFiles: 200_000, skippedFiles },
    })

    expect(md).toContain("  - `vendor/f199999.ts`")
    expectPastSpreadLimit(sectionOf(md, "## Files not analysed"))
  })

  it("renders a workspace page of 200,000 components", () => {
    const components = Array.from({ length: 200_000 }, (_, i) =>
      component({ id: `c${i}`, name: `C${i}` }),
    )
    const md = projectWorkspace(makeIR({ components }))

    expect(md).toContain("| c199999 |")
    expectPastSpreadLimit(sectionOf(md, "## Components"))
  })

  it("renders a workspace page of 200,000 component dependencies", () => {
    const dependencies = Array.from({ length: 200_000 }, (_, i) =>
      dependency({ from: `c${i}`, to: "hub" }),
    )
    const md = projectWorkspace(
      makeIR({ components: [component({ id: "hub", name: "Hub" })], dependencies }),
    )

    expect(md).toContain("- c199999 → hub (via `import`)")
    expectPastSpreadLimit(sectionOf(md, "## Component dependencies"))
  })

  it("renders a Slice of 50,000 members", { timeout: 30_000 }, () => {
    const memberAt = (i: number) =>
      makeSymbol({ id: `ts:src/a.ts#f${i}`, name: `f${i}`, fingerprint: zeroFp() })
    const changes: SymbolChange[] = Array.from({ length: 50_000 }, (_, i) => ({
      status: "added",
      symbol: memberAt(i),
    }))
    const md = projectDiff(
      makeDiff({
        symbols: changes,
        slices: [
          {
            id: sliceId("slice:ts:src/a.ts#f0"),
            members: changes.map((_, i) => symbolId(`ts:src/a.ts#f${i}`)),
          },
        ],
      }),
    )

    expect(md).toContain("(50000 members)")
    expectPastSpreadLimit(sectionOf(md, "## 🧵 Slice View"))
  })
})
