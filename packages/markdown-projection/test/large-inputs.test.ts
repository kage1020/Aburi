import {
  component,
  dependency,
  effect,
  makeDiff,
  makeIR,
  makeSymbol,
  sliceId,
  symbolId,
  zeroFp,
} from "@aburi/test-support"
import type { IR, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectComponent, projectDiff, projectWorkspace } from "../src"
import { sectionOf } from "./markdown"

const LARGE = 200_000

/** The section is longer than one call's argument list can be, so it was never spread into one. */
function expectPastSpreadLimit(lines: readonly string[]): void {
  expect(() => {
    const probe: string[] = []
    probe.push(...lines)
  }).toThrow(RangeError)
}

describe("projections of workspace-sized lists", () => {
  it("renders a component page of 40,000 Symbols", () => {
    const symbols = Array.from({ length: 40_000 }, (_, i) =>
      makeSymbol({ id: `ts:src/d${i % 30}/m${i}.ts#f${i}`, name: `f${i}` }),
    )
    const md = projectComponent({
      component: component({ id: "app", name: "App" }),
      symbols,
      dependencies: [],
    })

    expect(md).toContain("`f39999`")
    expect(md).not.toContain("## Boundary effect surface")
    expectPastSpreadLimit(sectionOf(md, "## Symbols"))
  })

  it("renders a boundary effect surface of 200,000 Symbols", { timeout: 30_000 }, () => {
    const reads = [effect({ id: "db.read", target: "db.user.find", plugin: "effects-prisma" })]
    const symbols = Array.from({ length: LARGE }, (_, i) =>
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

  it.each<[string, () => IR, string, string]>([
    [
      "skipped files",
      () => {
        const base = makeIR()
        const skippedFiles = Array.from({ length: LARGE }, (_, i) => ({
          path: `vendor/f${i}.ts`,
          reason: "parse-failed" as const,
        }))
        return { ...base, stats: { ...base.stats, totalFiles: LARGE, skippedFiles } }
      },
      "## Files not analysed",
      "  - `vendor/f199999.ts`",
    ],
    [
      "components",
      () =>
        makeIR({
          components: Array.from({ length: LARGE }, (_, i) =>
            component({ id: `c${i}`, name: `C${i}` }),
          ),
        }),
      "## Components",
      "| c199999 | `apps/c199999` | ts | — | 0 |",
    ],
    [
      "component dependencies",
      () =>
        makeIR({
          components: [component({ id: "hub", name: "Hub" })],
          dependencies: Array.from({ length: LARGE }, (_, i) =>
            dependency({ from: `c${i}`, to: "hub" }),
          ),
        }),
      "## Component dependencies",
      "- `c199999` → `hub` (via `import`)",
    ],
  ])("renders a workspace page of 200,000 %s", (_, ir, heading, line) => {
    const section = sectionOf(projectWorkspace(ir()), heading)

    expect(section).toContain(line)
    expectPastSpreadLimit(section)
  })

  it.each<[string, (i: number) => number | null]>([
    ["no calls between them", () => null],
    ["each calling the next", (i) => (i + 1 < LARGE ? i + 1 : null)],
  ])("renders a Slice of 200,000 members with %s", { timeout: 30_000 }, (_, callee) => {
    const id = (i: number) => symbolId(`ts:src/a.ts#f${i}`)
    const changes: SymbolChange[] = Array.from({ length: LARGE }, (_, i) => {
      const next = callee(i)
      return {
        status: "added",
        symbol: makeSymbol({
          id: id(i),
          name: `f${i}`,
          fingerprint: zeroFp(),
          calls: next === null ? [] : [{ target: `f${next}`, line: 2, resolved: id(next) }],
        }),
      }
    })
    const md = projectDiff(
      makeDiff({
        symbols: changes,
        slices: [{ id: sliceId("slice:ts:src/a.ts#f0"), members: changes.map((_, i) => id(i)) }],
      }),
    )

    expect(md).toContain(`(${LARGE} symbols)`)
    expectPastSpreadLimit(sectionOf(md, "## 🧵 Slice View"))
  })
})
