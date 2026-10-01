import {
  component,
  decorator,
  effect,
  makeIR,
  makeSymbol,
  sliceId,
  symbolId,
} from "@aburi/test-support"
import type { SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectComponent, projectWorkspace } from "../src"
import { projectDiff } from "../src/diff"
import { makeDiff } from "./fixtures"

/**
 * Lists whose length the workspace decides, sized past the point where appending them with
 * `push(...lines)` overflows the stack (roughly 120,000 arguments). The throw ended `aburi scan`
 * on a single-component repository of about 1,500 files; nothing here caps a component, a
 * Slice or the list of skipped files, so a page has to render at any of these sizes.
 */

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
  })

  it("renders a boundary effect surface of 130,000 Symbols", () => {
    const symbols = Array.from({ length: 130_000 }, (_, i) => ({
      ...symbolAt(i),
      decorators: [decorator({ name: "Get", boundary: true })],
      effects: [effect({ id: "db.read", target: "db.user.find", plugin: "effects-prisma" })],
    }))
    const md = projectComponent({
      component: component({ id: "app", name: "App" }),
      symbols,
      dependencies: [],
    })

    expect(md).toContain("- `f129999` — db.read(`db.user.find`)")
  })

  it("renders a workspace page that skipped 130,000 files", () => {
    const skippedFiles = Array.from({ length: 130_000 }, (_, i) => ({
      path: `vendor/f${i}.ts`,
      reason: "parse-failed" as const,
    }))
    const base = makeIR()
    const md = projectWorkspace({
      ...base,
      stats: { ...base.stats, totalFiles: 130_000, skippedFiles },
    })

    expect(md).toContain("  - `vendor/f129999.ts`")
  })

  it("renders a Slice of 50,000 members", () => {
    const changes: SymbolChange[] = Array.from({ length: 50_000 }, (_, i) => ({
      status: "added",
      symbol: symbolAt(i),
    }))
    const md = projectDiff(
      makeDiff({
        symbols: changes,
        slices: [
          {
            id: sliceId("slice:ts:src/d0/m0.ts#f0"),
            members: changes.map((_, i) => symbolId(`ts:src/d${i % 30}/m${i}.ts#f${i}`)),
          },
        ],
      }),
    )

    expect(md).toContain("(50000 members)")
  })
})
