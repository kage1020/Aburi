import { projectDiff } from "@aburi/markdown-projection"
import { diffIRs } from "@aburi/test-harness"
import { componentId, languageId, makeIR } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"

function billing(overrides: { name?: string; description?: string | null } = {}): IR {
  return makeIR({
    components: [
      {
        id: componentId("billing"),
        name: overrides.name ?? "Billing",
        roots: ["apps/billing"],
        languages: [languageId("ts")],
        description: overrides.description ?? null,
      },
    ],
  })
}

describe("component change: diff → Markdown", () => {
  it("carries a rename from buildDiff through to a rendered row", () => {
    const diff = diffIRs(billing(), billing({ name: "Billing & Invoicing" }))

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
    const md = projectDiff(diffIRs(billing(), billing({ description: "Settlement and payouts" })))

    expect(md).toContain("- `billing`: description (none → `Settlement and payouts`)")
  })

  it("leaves an untouched component out of the report entirely", () => {
    const diff = diffIRs(billing({ description: "Invoices" }), billing({ description: "Invoices" }))

    expect(diff.summary.componentsChanged).toBe(0)
    expect(projectDiff(diff)).not.toContain("## 🧱 Component changes")
  })
})
