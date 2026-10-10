import { component, languageId } from "@aburi/test-support"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, makeDiff } from "./fixtures"

function changedDiff(
  before: Component,
  after: Component,
  delta = { rootsChanged: false, publicApiChanged: false, frameworksChanged: false },
) {
  return makeDiff({
    summary: { ...emptySummary(), componentsChanged: 1 },
    components: { added: [], removed: [], changed: [{ before, after, delta }] },
  })
}

function componentSection(md: string): string[] {
  const lines = md.split("\n")
  const start = lines.indexOf("## 🧱 Component changes")
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith("## "))
  return end < 0 ? rest : rest.slice(0, end)
}

function changedRow(md: string): string {
  const row = componentSection(md).find((line) => line.startsWith("- `billing`"))
  expect(row).toBeDefined()
  return row ?? ""
}

describe("component changes section", () => {
  it("renders a display-name change with its before → after", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing" }),
        component({ id: "billing", name: "Billing & Invoicing" }),
      ),
    )
    expect(md).toContain("## 🧱 Component changes")
    expect(changedRow(md)).toBe("- `billing`: name (`Billing` → `Billing & Invoicing`)")
  })

  it("renders an added language", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing", languages: [languageId("ts")] }),
        component({
          id: "billing",
          name: "Billing",
          languages: [languageId("ts"), languageId("py")],
        }),
      ),
    )
    expect(changedRow(md)).toBe("- `billing`: languages")
  })

  it("renders a description added, and spells an absent one `none`", () => {
    const none = component({ id: "billing", name: "Billing", description: null })
    const written = component({ id: "billing", name: "Billing", description: "Invoices" })
    expect(changedRow(projectDiff(changedDiff(none, written)))).toBe(
      "- `billing`: description (none → `Invoices`)",
    )
    expect(changedRow(projectDiff(changedDiff(written, none)))).toBe(
      "- `billing`: description (`Invoices` → none)",
    )
  })

  it("spells an empty description apart from an absent one", () => {
    const none = component({ id: "billing", name: "Billing", description: null })
    const empty = component({ id: "billing", name: "Billing", description: "" })
    expect(changedRow(projectDiff(changedDiff(none, empty)))).toBe(
      "- `billing`: description (none → (empty))",
    )
  })

  it("keeps naming the three delta axes, in Component field order", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing", roots: ["apps/billing"], frameworks: [] }),
        component({
          id: "billing",
          name: "Billing",
          roots: ["apps/billing", "packages/billing-domain"],
          publicApi: ["apps/billing/routes/**"],
          frameworks: ["nestjs"],
        }),
        { rootsChanged: true, publicApiChanged: true, frameworksChanged: true },
      ),
    )
    expect(changedRow(md)).toBe("- `billing`: roots, publicApi, frameworks")
  })

  it("orders scalars and list fields in one row, name first and description last", () => {
    const md = projectDiff(
      changedDiff(
        component({
          id: "billing",
          name: "Billing",
          roots: ["apps/billing"],
          description: "Invoices",
        }),
        component({
          id: "billing",
          name: "Billing, Invoicing & Dunning",
          roots: ["apps/billing", "packages/billing-domain"],
          languages: [languageId("ts"), languageId("py")],
          description: "Invoices and dunning",
        }),
        { rootsChanged: true, publicApiChanged: false, frameworksChanged: false },
      ),
    )
    expect(changedRow(md)).toBe(
      "- `billing`: name (`Billing` → `Billing, Invoicing & Dunning`), roots, languages, " +
        "description (`Invoices` → `Invoices and dunning`)",
    )
  })

  it("names the component alone when the artifact reports a change no field shows", () => {
    const same = component({ id: "billing", name: "Billing" })
    expect(changedRow(projectDiff(changedDiff(same, same)))).toBe("- `billing`")
  })

  it("names a field this version of the renderer has never heard of", () => {
    const before = component({ id: "billing", name: "Billing" })
    const after = { ...before, owners: ["platform"] } as unknown as Component
    expect(changedRow(projectDiff(changedDiff(before, after)))).toBe("- `billing`: owners")
  })

  it("reads an omitted Class A / Class B key as the value it stands for", () => {
    const explicit = component({
      id: "billing",
      name: "Billing",
      publicApi: [],
      frameworks: [],
      description: null,
    })
    const omitted: Component = {
      id: explicit.id,
      name: explicit.name,
      roots: explicit.roots,
      languages: explicit.languages,
    }
    expect(changedRow(projectDiff(changedDiff(explicit, omitted)))).toBe("- `billing`")
  })
})

describe("component changes section — free-form text cannot break the row", () => {
  it("widens the fence past a backtick run inside the value", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing" }),
        component({ id: "billing", name: "a ``b`` c" }),
      ),
    )
    expect(changedRow(md)).toBe("- `billing`: name (`Billing` → ```a ``b`` c```)")
  })

  it("pads a value whose edge is a backtick, so CommonMark's strip does not eat it", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing" }),
        component({ id: "billing", name: "`code`" }),
      ),
    )
    expect(changedRow(md)).toBe("- `billing`: name (`Billing` → `` `code` ``)")
  })

  it("collapses a newline rather than ending the list item", () => {
    const md = projectDiff(
      changedDiff(
        component({ id: "billing", name: "Billing", description: null }),
        component({ id: "billing", name: "Billing", description: "one\n\n## two\n- three" }),
      ),
    )
    const row = changedRow(md)
    expect(row).toBe("- `billing`: description (none → `one ## two - three`)")
    // One row, so the section carries no stray heading or bullet the value smuggled in.
    expect(componentSection(md).filter((line) => line.startsWith("-"))).toEqual([row])
  })
})
