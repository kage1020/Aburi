import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { component, emptySummary, languageId, makeDiff } from "./fixtures"

/**
 * §6.2 🧱 Component changes. The fields listed for a changed Component come from the entry's
 * `before` / `after`, not from its `delta`: the delta summarises three axes, and a rename, a new
 * language or an edited description moves none of them (diff-algorithm.md §6.1). Entries with
 * all three booleans `false` did not exist until that section was fixed — a renderer reading
 * only the booleans would draw them as a row whose colon is followed by nothing, which is why
 * both halves moved together.
 *
 * `name` and `description` are free-form text out of the config file and this row reaches a PR
 * comment body through `@aburi/github-action`, so the cases below also pin that no value can
 * break out of its code span.
 */

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

/**
 * The rows of the 🧱 Component changes section, and only those. Scanning the whole document for
 * a `- \`billing\`` prefix would silently start reading another section's row the day one is
 * emitted with the same shape.
 */
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

  // The shape the field-order case above cannot pin: two scalars carrying an inline
  // before → after on either side of bare list-field names, in one row, asserted whole. The
  // name also carries a comma, which is what the code spans are there to tell apart from the
  // `, ` between fields.
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
    // What an IR written by a newer Aburi looks like to an older CLI: `readIR` does not reject
    // the keys it does not know, and `diffComponents` compares the whole record, so an entry
    // arrives here for a field with no rendering of its own.
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
