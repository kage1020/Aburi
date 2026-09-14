import { buildDiff } from "@aburi/diff"
import { projectDiff } from "@aburi/markdown-projection"
import type { Component, ComponentId, IR, LanguageId, RelativePath } from "@aburi/types"
import { describe, expect, it } from "vitest"

/**
 * The two halves of the Component-change fix, joined: `@aburi/diff` decides a component changed,
 * `@aburi/markdown-projection` renders the entry. Each package's own suite hand-writes the other
 * side — the projection tests build `delta` by hand — so neither can show that the renderer
 * stopped reading `delta` when the diff stopped deciding by it. That is the whole claim of the
 * change, and this is the only place it is checked end to end.
 *
 * IRs are written out here rather than imported: `@aburi/diff`'s fixtures are test-private, and
 * a component-only IR is small enough that spelling it is clearer than reaching for a builder.
 */

const IR_SCHEMA = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"

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

function diffOf(baseIR: IR, headIR: IR) {
  return buildDiff({
    baseIR,
    headIR,
    base: { ref: "main", irSchema: IR_SCHEMA },
    head: { ref: "HEAD", irSchema: IR_SCHEMA },
  })
}

describe("component change: diff → Markdown", () => {
  it("carries a rename from buildDiff through to a rendered row", () => {
    const diff = diffOf(
      componentIR({ id: "billing", name: "Billing" }),
      componentIR({ id: "billing", name: "Billing & Invoicing" }),
    )
    // Nothing the delta names moved — which is exactly the case that produced no entry at all,
    // and so never reached the renderer.
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
      diffOf(
        componentIR({ id: "billing", name: "Billing" }),
        componentIR({ id: "billing", name: "Billing", description: "Settlement and payouts" }),
      ),
    )
    expect(md).toContain("- `billing`: description (none → `Settlement and payouts`)")
  })

  it("leaves an untouched component out of the report entirely", () => {
    const ir = componentIR({ id: "billing", name: "Billing", description: "Invoices" })
    const diff = diffOf(
      ir,
      componentIR({ id: "billing", name: "Billing", description: "Invoices" }),
    )
    expect(diff.summary.componentsChanged).toBe(0)
    expect(projectDiff(diff)).not.toContain("## 🧱 Component changes")
  })
})
