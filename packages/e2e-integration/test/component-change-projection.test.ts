import { projectDiff } from "@aburi/markdown-projection"
import type { Component, ComponentId, IR, LanguageId, RelativePath } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, IR_SCHEMA } from "../src/scan-helper"

/**
 * The two halves of the Component-change fix, joined: `@aburi/diff` decides a component changed,
 * `@aburi/markdown-projection` renders the entry. Each package's own suite hand-writes the other
 * side — the projection tests build `delta` by hand — so neither can show that the renderer
 * stopped reading `delta` when the diff stopped deciding by it. This is the only place it is
 * checked end to end.
 *
 * IRs are written out here rather than imported: `@aburi/diff`'s fixtures are test-private, and
 * a component-only IR is small enough that spelling it is clearer than reaching for a builder.
 */

function componentIR(overrides: Omit<Partial<Component>, "id"> & { id: string; name: string }): IR {
  const component: Component = {
    id: overrides.id as ComponentId,
    name: overrides.name,
    roots: overrides.roots ?? (["apps/billing"] as RelativePath[]),
    languages: overrides.languages ?? (["ts"] as LanguageId[]),
    description: overrides.description ?? null,
  }
  return {
    $schema: IR_SCHEMA,
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: ["ts"] as LanguageId[] },
    components: [component],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

describe("component change: diff → Markdown", () => {
  it("carries a rename from buildDiff through to a rendered row", () => {
    const diff = diffIRs(
      componentIR({ id: "billing", name: "Billing" }),
      componentIR({ id: "billing", name: "Billing & Invoicing" }),
    )
    // Nothing the delta names moved — exactly the case that produced no entry at all, and so
    // never reached the renderer.
    expect(diff.summary.componentsChanged).toBe(1)
    expect(diff.components.changed[0]?.delta).toEqual({
      rootsChanged: false,
      publicApiChanged: false,
      frameworksChanged: false,
    })

    const md = projectDiff(diff)
    expect(md).toContain("## 🧱 Component changes")
    expect(md).toContain("- `billing`: name (`Billing` → `Billing & Invoicing`)")
  })

  it("carries a description edit through, spelling an absent one `none`", () => {
    const md = projectDiff(
      diffIRs(
        componentIR({ id: "billing", name: "Billing" }),
        componentIR({ id: "billing", name: "Billing", description: "Settlement and payouts" }),
      ),
    )
    expect(md).toContain("- `billing`: description (none → `Settlement and payouts`)")
  })

  it("leaves an untouched component out of the report entirely", () => {
    const diff = diffIRs(
      componentIR({ id: "billing", name: "Billing", description: "Invoices" }),
      componentIR({ id: "billing", name: "Billing", description: "Invoices" }),
    )
    expect(diff.summary.componentsChanged).toBe(0)
    expect(projectDiff(diff)).not.toContain("## 🧱 Component changes")
  })
})
